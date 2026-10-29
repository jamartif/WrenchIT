import * as vscode from 'vscode';
import * as jsyaml from 'js-yaml';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('wrenchit.encodeBase64', () => encodeBase64()),
    vscode.commands.registerCommand('wrenchit.decodeBase64', () => decodeBase64()),
    vscode.commands.registerCommand('wrenchit.fixJson', () => fixJson()),
    vscode.commands.registerCommand('wrenchit.decodeJwt', () => decodeJwt()),
    vscode.commands.registerCommand('wrenchit.previewOpenApi', () => previewOpenApi(context))
  );
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEditorAndSelection(): {
  editor: vscode.TextEditor;
  selection: vscode.Selection;
  text: string;
} | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('WrenchIT: No hay ningún editor activo.');
    return undefined;
  }
  return { editor, selection: editor.selection, text: editor.document.getText(editor.selection) };
}

function replaceSelection(editor: vscode.TextEditor, selection: vscode.Selection, newText: string) {
  editor.edit(editBuilder => editBuilder.replace(selection, newText));
}

function replaceWholeDocument(editor: vscode.TextEditor, newText: string) {
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length)
  );
  editor.edit(editBuilder => editBuilder.replace(fullRange, newText));
}

// ---------------------------------------------------------------------------
// Encode Base64
// ---------------------------------------------------------------------------

function encodeBase64() {
  const ctx = getEditorAndSelection();
  if (!ctx) { return; }
  const { editor, selection, text } = ctx;

  if (!text) {
    vscode.window.showWarningMessage('WrenchIT: Selecciona el texto que quieres codificar en Base64.');
    return;
  }

  const encoded = Buffer.from(text, 'utf8').toString('base64');
  replaceSelection(editor, selection, encoded);
}

// ---------------------------------------------------------------------------
// Decode Base64
// ---------------------------------------------------------------------------

function decodeBase64() {
  const ctx = getEditorAndSelection();
  if (!ctx) { return; }
  const { editor, selection, text } = ctx;

  if (!text) {
    vscode.window.showWarningMessage('WrenchIT: Selecciona el texto Base64 que quieres decodificar.');
    return;
  }

  try {
    const decoded = Buffer.from(text.trim(), 'base64').toString('utf8');
    replaceSelection(editor, selection, decoded);
  } catch {
    vscode.window.showErrorMessage('WrenchIT: El texto seleccionado no es Base64 válido.');
  }
}

// ---------------------------------------------------------------------------
// Fix & Format JSON (Grafana cleaner)
// ---------------------------------------------------------------------------

function fixJson() {
  const ctx = getEditorAndSelection();
  if (!ctx) { return; }
  const { editor, selection } = ctx;

  // Use selection if non-empty, otherwise use the whole document
  const hasSelection = !selection.isEmpty;
  const raw = hasSelection
    ? editor.document.getText(selection)
    : editor.document.getText();

  if (!raw.trim()) {
    vscode.window.showWarningMessage('WrenchIT: El editor está vacío.');
    return;
  }

  const result = cleanAndParseJson(raw);

  if (!result.ok) {
    // Aunque falle, reemplazar con el mejor intento para que el usuario vea qué quedó
    if (hasSelection) {
      replaceSelection(editor, selection, result.bestAttempt);
    } else {
      replaceWholeDocument(editor, result.bestAttempt);
    }
    vscode.window.showWarningMessage(`WrenchIT: JSON inválido aun después de limpiar. Contenido reemplazado con el mejor intento para inspección. ${result.error}`);
    return;
  }

  const formatted = formatJsonText(result.bestAttempt);

  if (hasSelection) {
    replaceSelection(editor, selection, formatted);
  } else {
    replaceWholeDocument(editor, formatted);
  }
}

// ---------------------------------------------------------------------------
// JSON cleaning pipeline
// ---------------------------------------------------------------------------

interface ParseOk   { ok: true;  value: unknown; bestAttempt: string }
interface ParseFail { ok: false; error: string;  bestAttempt: string }
type ParseResult = ParseOk | ParseFail;

/**
 * Tries multiple strategies to extract valid JSON from a messy string.
 * Each strategy produces a candidate string; the first that JSON.parse()
 * accepts wins.
 */
export function cleanAndParseJson(raw: string): ParseResult {
  const strategies: Array<(s: string) => string> = [
    // 1. As-is (already valid JSON)
    s => s,
    // 2. Trim whitespace only
    s => s.trim(),
    // 3. Unwrap a single outer "..." layer via JSON.parse (proper unescaping)
    s => tryUnwrapString(s.trim()),
    // 4. Wrap in outer quotes and JSON.parse — handles {\"k\":\"v\"} with no
    //    outer quotes by making the engine unescape everything in one shot
    s => wrapAndUnescape(s.trim()),
    // 5. Forward-slash patterns + one-pass backslash removal
    s => s.trim().replace(/(?<![A-Za-z0-9._-])\/+(?=")/g, '').replace(/\\"/g, '"'),
    // 6. Symmetrical forward-slash wrapping on both sides of strings:
    //    /"key/"  //"val//"  ///"x///"
    //    Backslashes are left for unescapeOneLayer: they are JSON escapes, not
    //    Grafana delimiters. Requires slashes on BOTH sides, so a URL with a
    //    trailing / is safe.
    //    Note: : excluded from lookbehind because :///"val///" is a Grafana pattern,
    //    not a URL (real URLs have :// followed by domain letters, never by ").
    s => s.trim().replace(/(?<![A-Za-z0-9._-])\/+(")([^"]*?)\/+(")/g, '$1$2$3'),
    // 7. Full Grafana deep-clean (multi-pass, all patterns)
    s => grafanaDeepClean(s.trim()),
    // 8. Deep-clean + unwrap (for double-wrapped content)
    s => tryUnwrapString(grafanaDeepClean(s.trim())),
  ];

  let bestAttempt = raw;

  for (const strategy of strategies) {
    let cleaned: string;
    try {
      cleaned = strategy(raw);
    } catch {
      continue;
    }
    bestAttempt = cleaned;
    // Aunque el texto ya sea JSON válido, Grafana suele dejar objetos y arrays
    // metidos en strings ("{\"k\":1}", "[{...}]"). Se desenvuelven aquí.
    const finalized = finalizeJsonText(cleaned);
    if (jsonParsable(finalized)) {
      return { ok: true, value: JSON.parse(finalized), bestAttempt: finalized };
    }
  }

  return {
    ok: false,
    error: 'Ninguna estrategia de limpieza produjo JSON válido.',
    bestAttempt
  };
}

function jsonParsable(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Building blocks used by the strategies
// ---------------------------------------------------------------------------

/**
 * If s is wrapped in outer double-quotes (a JSON string literal), use
 * JSON.parse to properly unescape it and return the inner content.
 * Falls back to manually stripping the outer quotes if parse fails.
 */
function tryUnwrapString(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner = JSON.parse(s);
      if (typeof inner === 'string') { return inner; }
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Wraps the content in outer double-quotes so JSON.parse treats it as a
 * string literal and applies proper unescaping in one shot.
 *
 * Works when Grafana gives bare content like  {\"key\": \"value\"}
 * (escaped quotes, no outer wrapper).  No existing raw `"` must be present
 * for this to succeed — if there are any, the JSON.parse will throw and the
 * strategy is skipped.
 */
function wrapAndUnescape(s: string): string {
  const result = JSON.parse(`"${s}"`);
  return typeof result === 'string' ? result : s;
}

/**
 * Removes outer quotes from JSON string values whose content is an unescaped
 * JSON object or array.
 *
 * Example:  "Content":"{"key":"val"}"  →  "Content":{"key":"val"}
 *
 * Works by scanning for the pattern  :"{ or  :"[  and then balancing
 * braces/brackets to find the matching close, checking that it is immediately
 * followed by ".  Runs in a loop until no more substitutions can be made
 * (handles multiple nested occurrences).
 */
function unquoteJsonStringValues(s: string): string {
  let result = s;
  let changed = true;

  while (changed) {
    changed = false;

    for (const [open, close] of [['{', '}'], ['[', ']']] as [string, string][]) {
      let searchFrom = 0;

      while (searchFrom < result.length) {
        const pattern = `:"${open}`;
        const idx = result.indexOf(pattern, searchFrom);
        if (idx === -1) break;

        const quotePos = idx + 1; // position of the opening "
        const openPos  = idx + 2; // position of { or [

        // Balance brackets to find the matching close
        let depth = 1;
        let pos   = openPos + 1;
        while (pos < result.length && depth > 0) {
          if      (result[pos] === open)  { depth++; }
          else if (result[pos] === close) { depth--; }
          pos++;
        }

        const closePos = pos - 1; // position of } or ]
        const inner = result.slice(openPos, closePos + 1);

        // Only strip if the closing bracket is immediately followed by " and the
        // inside is JSON. Otherwise a string like "{not json}" would be damaged.
        if (closePos + 1 < result.length && result[closePos + 1] === '"' && jsonParsable(inner)) {
          result =
            result.slice(0, quotePos) +
            result.slice(quotePos + 1, closePos + 1) +
            result.slice(closePos + 2);
          changed = true;
          break; // restart outer loop
        } else {
          searchFrom = idx + 1;
        }
      }
      if (changed) break;
    }
  }

  return result;
}

/**
 * One JSON-string unescape layer, left to right.
 *
 * `\\` is consumed before `\"`, so `\\\"` (an escaped quote inside an
 * already-escaped string) becomes `\"` and not a raw quote. Repeating the
 * old global `\"` → `"` replacement ate those internal quotes and left the
 * document invalid (`"hello "world""`).
 */
function unescapeOneLayer(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '"' || next === '\\' || next === '/') {
        out += next;
        i++;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}

function isEscapedQuote(s: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && s[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function findMatchingBracket(s: string, openIdx: number): number {
  const open = s[openIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;

  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === '"') break;
        i++;
      }
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return c === close ? i : -1;
    }
  }
  return -1;
}

/**
 * Replaces `"{` → `{`, `}"` → `}`, `"[` → `[` and `]"` → `]` when those
 * quotes wrap a JSON object or array (optional whitespace in between).
 * Quotes that merely sit next to a brace inside a normal string are kept.
 */
function stripQuotedContainers(input: string): string {
  let s = input;
  for (let guard = 0; guard < 50; guard++) {
    const next = stripOneQuotedContainer(s);
    if (next === s) return s;
    s = next;
  }
  return s;
}

function stripOneQuotedContainer(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"' || isEscapedQuote(s, i)) continue;

    let openAt = i + 1;
    while (openAt < s.length && /\s/.test(s[openAt])) openAt++;
    const open = s[openAt];
    if (open !== '{' && open !== '[') continue;

    const closeIdx = findMatchingBracket(s, openAt);
    if (closeIdx < 0) continue;

    let quoteAt = closeIdx + 1;
    while (quoteAt < s.length && /\s/.test(s[quoteAt])) quoteAt++;
    if (s[quoteAt] !== '"' || isEscapedQuote(s, quoteAt)) continue;

    let after = quoteAt + 1;
    while (after < s.length && /\s/.test(s[after])) after++;
    // A quote followed by `:` is an object key, not a wrapped value.
    if (s[after] === ':') continue;

    const inner = s.slice(openAt, closeIdx + 1);
    if (!jsonParsable(inner)) continue;

    return s.slice(0, i) + inner + s.slice(quoteAt + 1);
  }
  return s;
}

function normalizeLooseJson(s: string): string {
  let result = stripQuotedContainers(s);
  result = unquoteJsonStringValues(result);
  result = result.replace(/"([^"/]*)\/+"/g, '"$1"');
  result = result.replace(/"(\{\s*\})"/g, '$1');
  result = result.replace(/"(\[\s*\])"/g, '$1');
  result = result.replace(/""([^"\\]*)""/g, '"$1"');
  result = result.replace(/^"(\{[\s\S]*\})"$/, '$1')
                 .replace(/^"(\[[\s\S]*\])"$/, '$1');
  result = result.replace(/,\s*([}\]])/g, '$1');
  return result;
}

function scanStringEnd(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i + 1;
    i++;
  }
  return s.length;
}

function tryPromoteStringLiteral(literal: string): string {
  try {
    const value = JSON.parse(literal);
    if (typeof value !== 'string') return literal;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return literal;
    if (!jsonParsable(trimmed)) return literal;
    return trimmed;
  } catch {
    return literal;
  }
}

/**
 * Promotes string values whose content is a JSON object or array.
 * Works on text so numeric literals such as `150.0` are not reserialized.
 */
function promoteEmbeddedJsonStrings(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8; pass++) {
    const next = promoteOnce(current);
    if (next === current || !jsonParsable(next)) return current;
    current = next;
  }
  return current;
}

function promoteOnce(json: string): string {
  const stack: Array<'object' | 'array'> = [];
  type Expect = 'value' | 'key' | 'colon' | 'comma-or-end';
  let expect: Expect = 'value';
  let out = '';
  let i = 0;

  while (i < json.length) {
    const ws = i;
    while (i < json.length && /\s/.test(json[i])) i++;
    out += json.slice(ws, i);
    if (i >= json.length) break;

    const ch = json[i];
    if (ch === '{') {
      stack.push('object');
      out += ch;
      i++;
      expect = 'key';
      continue;
    }
    if (ch === '[') {
      stack.push('array');
      out += ch;
      i++;
      expect = 'value';
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      out += ch;
      i++;
      expect = 'comma-or-end';
      continue;
    }
    if (ch === ':') {
      out += ch;
      i++;
      expect = 'value';
      continue;
    }
    if (ch === ',') {
      out += ch;
      i++;
      expect = stack[stack.length - 1] === 'object' ? 'key' : 'value';
      continue;
    }
    if (ch === '"') {
      const end = scanStringEnd(json, i);
      const literal = json.slice(i, end);
      const isValue: boolean = expect === 'value';
      out += isValue ? tryPromoteStringLiteral(literal) : literal;
      i = end;
      expect = isValue ? 'comma-or-end' : 'colon';
      continue;
    }

    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(json.slice(i));
    if (!match) {
      out += json.slice(i);
      return out;
    }
    out += match[0];
    i += match[0].length;
    expect = 'comma-or-end';
  }

  return out;
}

function finalizeJsonText(text: string): string {
  let current = text.trim();

  for (let i = 0; i < 5; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return current;
    }
    if (typeof parsed !== 'string') break;
    const inner = parsed.trim();
    if (!(inner.startsWith('{') || inner.startsWith('[')) || !jsonParsable(inner)) {
      return current;
    }
    current = inner;
  }

  const promoted = promoteEmbeddedJsonStrings(current);
  return jsonParsable(promoted) ? promoted : current;
}

/**
 * Full multi-pass Grafana cleaner.
 *
 * Handles:
 *  - BOM and Windows line endings
 *  - Outer "..." wrapping (one or two levels)
 *  - Symmetrical slash-wrapping:  /"key/"  //"v//"  ///"x///"  \/"k\/"  etc.
 *  - Forward slashes before quotes:  /"  ///"  (non-URL context)
 *  - Multi-level backslash escaping:  \"  \\"  \\\"  → "
 *  - Escaped forward slash:  \/  → /
 *  - Trailing commas before } or ]
 */
function grafanaDeepClean(s: string): string {
  let result = s;

  // Remove UTF-8 BOM if present
  result = result.replace(/^\uFEFF/, '');

  // Normalize line endings
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Unwrap one or two levels of outer "..." string wrapping
  result = tryUnwrapString(result);
  result = tryUnwrapString(result); // second pass for double-wrapped content

  // Remove symmetrical slash/backslash wrapping around strings:
  //   /"key/"   //"value//"   ///"x///"   \/"k\/"   \\/"v\\/"   etc.
  // Must run BEFORE the asymmetric leading-slash removal below.
  // Requiring slashes on BOTH sides keeps URLs with a trailing / intact.
  // Note: : not in lookbehind — :///"val///" is a Grafana delimiter pattern,
  // real URLs have :// followed by domain letters, never directly by ".
  // Only forward slashes. A backslash before a quote is a JSON escape (`\"`)
  // and has to survive until unescapeOneLayer, otherwise `\"world\"` collapses.
  result = result.replace(/(?<![A-Za-z0-9._-])\/+(")([^"]*?)\/+(")/g, '$1$2$3');

  // Remove forward slashes immediately before a double-quote when they are
  // NOT part of a URL (i.e. not preceded by letters, digits, dot…).
  // Covers:  /"key"  ///"key"  \/"key"  :///"val"  and similar Grafana artifacts.
  result = result.replace(/(?<![A-Za-z0-9._-])\/+(?=")/g, '');

  // Unescape one layer at a time and, after each layer, drop the quotes Grafana
  // leaves glued to braces and brackets. Stop as soon as the text parses so
  // internal quotes (`hello \"world\"`) are not stripped one level too far.
  for (let i = 0; i < 6; i++) {
    const normalized = normalizeLooseJson(result);
    if (jsonParsable(normalized)) return normalized;

    const unescaped = unescapeOneLayer(normalized);
    if (unescaped === normalized) return normalized;
    result = unescaped;

    // Unescaping can reveal new /" sequences (e.g. /\" → /").
    result = result.replace(/(?<![A-Za-z0-9._-])\/+(")([^"]*?)\/+(")/g, '$1$2$3');
    result = result.replace(/(?<![A-Za-z0-9._-])\/+(?=")/g, '');
  }

  return normalizeLooseJson(result);
}

// ---------------------------------------------------------------------------
// Decode JWT
// ---------------------------------------------------------------------------

function decodeJwt() {
  const ctx = getEditorAndSelection();
  if (!ctx) { return; }
  const { editor, selection, text } = ctx;

  if (!text.trim()) {
    vscode.window.showWarningMessage('WrenchIT: Selecciona el token JWT que quieres decodificar.');
    return;
  }

  const parts = text.trim().split('.');
  if (parts.length < 2) {
    vscode.window.showErrorMessage('WrenchIT: El texto seleccionado no tiene formato JWT (se esperan al menos 2 partes separadas por ".").');
    return;
  }

  try {
    const decoded = decodeJwtParts(parts[0], parts[1]);
    replaceSelection(editor, selection, decoded);
  } catch {
    vscode.window.showErrorMessage('WrenchIT: No se pudo decodificar el JWT. Comprueba que el token es válido.');
  }
}

function decodeJwtParts(headerB64: string, payloadB64: string): string {
  const decodeSegment = (seg: string): unknown => {
    // Base64url → Base64 standard → Buffer → UTF-8 → JSON
    const base64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json);
  };

  const header  = decodeSegment(headerB64);
  const payload = decodeSegment(payloadB64);

  const combined = JSON.stringify({ header, payload });
  return formatJsonText(combined);
}

// ---------------------------------------------------------------------------
// Preview OpenAPI (Swagger UI)
// ---------------------------------------------------------------------------

let openApiPanel: vscode.WebviewPanel | undefined;

function previewOpenApi(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('WrenchIT: No hay ningún editor activo.');
    return;
  }

  const hasSelection = !editor.selection.isEmpty;
  const raw = hasSelection
    ? editor.document.getText(editor.selection)
    : editor.document.getText();

  if (!raw.trim()) {
    vscode.window.showWarningMessage('WrenchIT: El editor está vacío.');
    return;
  }

  let spec: unknown;
  try {
    spec = parseOpenApiDocument(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'WrenchIT: No se pudo leer la spec.';
    vscode.window.showErrorMessage(message);
    return;
  }

  const themeKind = vscode.window.activeColorTheme?.kind;
  const darkMode = themeKind === vscode.ColorThemeKind.Dark
    || themeKind === vscode.ColorThemeKind.HighContrast;

  if (openApiPanel) {
    openApiPanel.reveal(vscode.ViewColumn.Beside);
  } else {
    openApiPanel = vscode.window.createWebviewPanel(
      'wrenchitOpenApiPreview',
      'Preview OpenAPI',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );
    openApiPanel.onDidDispose(() => { openApiPanel = undefined; });
  }

  openApiPanel.webview.html = buildSwaggerUiHtml(openApiPanel.webview, context, spec, darkMode);
}

/**
 * Accepts an OpenAPI document as JSON, YAML, a JSON string that contains the
 * document, or Grafana-escaped JSON. Returns the spec object Swagger UI can render.
 */
export function parseOpenApiDocument(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) {
    throw new Error('WrenchIT: El editor está vacío.');
  }

  const direct = interpretOpenApiText(text);
  if (direct) return direct;

  const cleaned = cleanAndParseJson(text);
  if (cleaned.ok) {
    const spec = asOpenApiSpec(cleaned.value);
    if (spec) return spec;
  }

  throw new Error(
    'WrenchIT: El contenido no es una spec OpenAPI/Swagger en JSON o YAML. Tiene que incluir el campo "openapi" o "swagger".'
  );
}

function interpretOpenApiText(text: string): unknown | undefined {
  try {
    return asOpenApiSpec(unwrapEncodedDocument(JSON.parse(text)));
  } catch {
    // Not JSON. YAML is tried next.
  }
  try {
    return asOpenApiSpec(unwrapEncodedDocument(jsyaml.load(text, { schema: jsyaml.JSON_SCHEMA })));
  } catch {
    return undefined;
  }
}

function unwrapEncodedDocument(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 4; i++) {
    if (typeof current !== 'string') return current;
    const inner = current.replace(/^\uFEFF/, '').trim();
    if (!inner) return current;
    try {
      current = JSON.parse(inner);
      continue;
    } catch {
      // The string may be YAML rather than JSON.
    }
    try {
      const loaded = jsyaml.load(inner, { schema: jsyaml.JSON_SCHEMA });
      if (typeof loaded === 'string' && loaded === inner) return current;
      current = loaded;
    } catch {
      return current;
    }
  }
  return current;
}

function asOpenApiSpec(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const spec = value as Record<string, unknown>;
  if (typeof spec.openapi === 'string' || typeof spec.swagger === 'string') return spec;
  return undefined;
}

/**
 * Embeds a value inside a <script> block. Every "<" becomes a JS unicode
 * escape so an OpenAPI description that contains "</script>" or "</SCRIPT>"
 * cannot close the script element (the HTML parser matches that tag
 * case-insensitively).
 */
function embedJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildSwaggerUiHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  spec: unknown,
  darkMode = false
): string {
  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'swagger-ui', file));

  const bundleJsUri = mediaUri('swagger-ui-bundle.js');
  const cssUri = mediaUri('swagger-ui.css');
  const redirectUri = mediaUri('oauth2-redirect.html');
  const specJson = embedJsonForScript(spec);
  const redirectJson = embedJsonForScript(String(redirectUri));
  const htmlClass = darkMode ? ' class="dark-mode"' : '';

  // BaseLayout: StandaloneLayout pinta una barra "Explore" con la URL vacía.
  // Pulsarla (o Enter) llama a download("") y sustituye la spec por
  // "Failed to load API definition" / "No API definition provided".
  // validatorUrl null: el validador remoto queda bloqueado por la CSP del webview.
  // La inicialización no espera a window.onload: VS Code escribe el HTML del
  // webview con document.write y ese evento no siempre llega a dispararse.
  return `<!DOCTYPE html>
<html lang="es"${htmlClass}>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data: blob:; font-src ${webview.cspSource} data:; connect-src http: https:;">
  <link rel="stylesheet" href="${cssUri}">
  <title>Preview OpenAPI</title>
  <style>
    html { box-sizing: border-box; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; }
    html.dark-mode body { background: #1c2022; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${bundleJsUri}"></script>
  <script>
    window.ui = SwaggerUIBundle({
      spec: ${specJson},
      dom_id: '#swagger-ui',
      deepLinking: false,
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
      validatorUrl: null,
      oauth2RedirectUrl: ${redirectJson},
      docExpansion: 'list'
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Text-level JSON formatter (preserves original numeric representations)
// ---------------------------------------------------------------------------

/**
 * Formats a valid JSON string with 2-space indentation working at the text
 * level, without going through JSON.parse → JSON.stringify.
 *
 * This preserves the original numeric representation of every value, so
 * `150.0` stays `150.0` instead of being coerced to `150` by the JS number
 * type.
 */
export function formatJsonText(json: string): string {
  let out = '';
  let indent = 0;
  let i = 0;
  const len = json.length;
  const pad = () => '  '.repeat(indent);

  while (i < len) {
    const ch = json[i];

    if (ch === '"') {
      // Copy the entire string literal verbatim, respecting escape sequences
      out += ch;
      i++;
      while (i < len) {
        const c = json[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < len) { out += json[i]; i++; }
        } else if (c === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
    } else if (ch === '{' || ch === '[') {
      const closeChar = ch === '{' ? '}' : ']';
      // Peek ahead to detect empty containers {} or []
      let j = i + 1;
      while (j < len && /\s/.test(json[j])) { j++; }
      if (json[j] === closeChar) {
        out += ch + closeChar;
        i = j + 1;
      } else {
        out += ch;
        indent++;
        out += '\n' + pad();
        i++;
      }
    } else if (ch === '}' || ch === ']') {
      indent--;
      out += '\n' + pad() + ch;
      i++;
    } else if (ch === ':') {
      out += ': ';
      i++;
    } else if (ch === ',') {
      out += ',\n' + pad();
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++; // skip whitespace outside strings
    } else {
      // Numbers (150.0, 3.14…), booleans, null — copy character as-is
      out += ch;
      i++;
    }
  }

  return out;
}
