import * as vscode from 'vscode';
import * as jsyaml from 'js-yaml';
import * as crypto from 'crypto';

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
    vscode.window.showErrorMessage('WrenchIT: No active editor.');
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
    vscode.window.showWarningMessage('WrenchIT: Select the text you want to encode as Base64.');
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
    vscode.window.showWarningMessage('WrenchIT: Select the Base64 text you want to decode.');
    return;
  }

  try {
    const decoded = Buffer.from(text.trim(), 'base64').toString('utf8');
    replaceSelection(editor, selection, decoded);
  } catch {
    vscode.window.showErrorMessage('WrenchIT: The selected text is not valid Base64.');
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
    vscode.window.showWarningMessage('WrenchIT: The editor is empty.');
    return;
  }

  const result = cleanAndParseJson(raw);

  if (!result.ok) {
    // Even on failure, replace with the best attempt so the user can see what is left
    if (hasSelection) {
      replaceSelection(editor, selection, result.bestAttempt);
    } else {
      replaceWholeDocument(editor, result.bestAttempt);
    }
    vscode.window.showWarningMessage(`WrenchIT: The JSON is still invalid after cleaning. The content was replaced with the best attempt so you can inspect it. ${result.error}`);
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
    // Even when the text is already valid JSON, Grafana often leaves objects and
    // arrays inside strings ("{\"k\":1}", "[{...}]"). They are unwrapped here.
    const finalized = finalizeJsonText(cleaned);
    if (jsonParsable(finalized)) {
      return { ok: true, value: JSON.parse(finalized), bestAttempt: finalized };
    }
  }

  return {
    ok: false,
    error: 'No cleaning strategy produced valid JSON.',
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
    vscode.window.showWarningMessage('WrenchIT: Select the JWT you want to decode.');
    return;
  }

  const parts = text.trim().split('.');
  if (parts.length < 2) {
    vscode.window.showErrorMessage('WrenchIT: The selected text is not a JWT (expected at least 2 parts separated by ".").');
    return;
  }

  try {
    const decoded = decodeJwtParts(parts[0], parts[1]);
    replaceSelection(editor, selection, decoded);
  } catch {
    vscode.window.showErrorMessage('WrenchIT: Could not decode the JWT. Check that the token is valid.');
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
    vscode.window.showErrorMessage('WrenchIT: No active editor.');
    return;
  }

  const hasSelection = !editor.selection.isEmpty;
  const raw = hasSelection
    ? editor.document.getText(editor.selection)
    : editor.document.getText();

  if (!raw.trim()) {
    vscode.window.showWarningMessage('WrenchIT: The editor is empty.');
    return;
  }

  let spec: unknown;
  try {
    spec = parseOpenApiDocument(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'WrenchIT: Could not read the spec.';
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
    proxyLifetime = new AbortController();
    proxyApprovedHosts.clear();
    openApiPanel.onDidDispose(() => {
      openApiPanel = undefined;
      proxyLifetime.abort();
      proxyApprovedHosts.clear();
    });
    openApiPanel.webview.onDidReceiveMessage(handleProxyMessage);
  }

  proxyAllowedHosts = collectSpecHosts(spec);

  openApiPanel.webview.html = buildSwaggerUiHtml(openApiPanel.webview, context, spec, darkMode);
}

export interface ProxyRequest {
  type: 'wrenchit.fetch';
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string; // base64
}

export type ProxyReply =
  | { ok: true; status: number; statusText: string; headers: Array<[string, string]>; body: string; url: string }
  | { ok: false; error: string };

export interface ProxyOptions {
  fetch: typeof fetch;
  /** Decides whether the extension may call this URL's host (see isProxyHostAllowed). */
  isHostAllowed: (url: URL) => boolean | Promise<boolean>;
  /** Aborts the request, e.g. when the preview is closed. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/** A request that has not finished after this long is cancelled. */
export const PROXY_TIMEOUT_MS = 30_000;
/** Largest request or response body the proxy carries, in bytes (it travels base64 in memory). */
export const PROXY_MAX_BYTES = 20 * 1024 * 1024;

/** "message: cause" for fetch errors, whose message alone is just "fetch failed". */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = (err as { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return err.message;
  const causeText = cause instanceof Error ? cause.message : String(cause);
  return causeText && causeText !== err.message ? `${err.message}: ${causeText}` : err.message;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Reads the whole body, failing as soon as it grows past maxBytes. */
async function readLimited(response: Response, maxBytes: number, abort: (reason: Error) => void): Promise<Buffer> {
  const tooLarge = () => new Error(`The response is larger than ${formatMegabytes(maxBytes)}; the preview does not load it.`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = tooLarge();
    abort(err);
    throw err;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const err = tooLarge();
      abort(err);
      await reader.cancel(err).catch(() => undefined);
      throw err;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Runs one "Try it out" request on behalf of the webview and returns the reply
 * to post back. It always settles: network errors, a closed preview, the
 * timeout and oversized bodies all end in { ok: false }.
 */
export async function runProxyRequest(message: ProxyRequest, options: ProxyOptions): Promise<ProxyReply> {
  const timeoutMs = options.timeoutMs ?? PROXY_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? PROXY_MAX_BYTES;
  const controller = new AbortController();
  const abort = (reason: Error) => { if (!controller.signal.aborted) controller.abort(reason); };
  const timer = setTimeout(() => abort(new Error(`No response after ${timeoutMs / 1000} s; the request was cancelled.`)), timeoutMs);
  const onOuterAbort = () => abort(new Error('The preview was closed; the request was cancelled.'));
  if (options.signal?.aborted) onOuterAbort();
  options.signal?.addEventListener('abort', onOuterAbort);
  try {
    const url = new URL(message.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Unsupported protocol ${url.protocol}`);
    }
    if (!(await options.isHostAllowed(url))) {
      throw new Error(`Requests to ${url.host} are not allowed from this preview.`);
    }
    const method = String(message.method || 'GET').toUpperCase();
    const hasBody = typeof message.body === 'string' && method !== 'GET' && method !== 'HEAD';
    // base64 grows 4/3: check before decoding so a huge body is never copied.
    if (hasBody && Math.floor((message.body!.length * 3) / 4) > maxBytes) {
      throw new Error(`The request body is larger than ${formatMegabytes(maxBytes)}; the preview does not send it.`);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await options.fetch(url, {
      method,
      headers: message.headers,
      body: hasBody ? Buffer.from(message.body!, 'base64') : undefined,
      redirect: 'follow',
      signal: controller.signal
    });
    const headers: Array<[string, string]> = [];
    response.headers.forEach((value, key) => headers.push([key, value]));
    // fetch already decoded the body, so drop headers that describe the wire format.
    const filtered = headers.filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase()));
    const body = (await readLimited(response, maxBytes, abort)).toString('base64');
    return { ok: true, status: response.status, statusText: response.statusText, headers: filtered, body, url: response.url };
  } catch (err) {
    // After an abort, fetch rejects with a generic AbortError: report why it was aborted.
    const reason = controller.signal.aborted ? controller.signal.reason : err;
    return { ok: false, error: describeError(reason) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** URL.host of a server URL, or undefined when it is relative or invalid. */
function absoluteHost(url: string): string | undefined {
  const trimmed = url.trim();
  if (!isAbsoluteUrl(trimmed)) return undefined;
  try {
    return new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Every URL a Server Object can produce, trying each enum value of its variables (capped). */
function expandServerUrlVariants(server: Record<string, any>, limit = 64): string[] {
  const variables = server.variables && typeof server.variables === 'object' ? server.variables : {};
  let urls: string[] = [String(server.url)];
  for (const [name, variable] of Object.entries<any>(variables)) {
    if (!variable || typeof variable !== 'object') continue;
    const values = new Set<string>();
    if (variable.default !== undefined) values.add(String(variable.default));
    if (Array.isArray(variable.enum)) variable.enum.forEach((v: unknown) => values.add(String(v)));
    if (values.size === 0) continue;
    const token = `{${name}}`;
    const next: string[] = [];
    for (const url of urls) {
      if (!url.includes(token)) { next.push(url); continue; }
      for (const value of values) {
        if (next.length >= limit) break;
        next.push(url.split(token).join(value));
      }
    }
    urls = next;
  }
  // A variable without default or enum leaves "{name}" behind: that URL is not known.
  return urls.filter((url) => !/\{[^{}]*\}/.test(url));
}

/**
 * Hosts the spec itself declares: absolute "servers" (top level, per path and
 * per operation, with their variable values) or the Swagger 2.0 "host".
 * "Try it out" may call these without asking.
 */
export function collectSpecHosts(spec: unknown): Set<string> {
  const hosts = new Set<string>();
  if (!spec || typeof spec !== 'object') return hosts;
  const doc = spec as Record<string, any>;
  if (typeof doc.swagger === 'string') {
    if (typeof doc.host === 'string' && doc.host.trim()) {
      const host = absoluteHost(`//${doc.host.trim()}`);
      if (host) hosts.add(host);
    }
    return hosts;
  }
  const addServers = (servers: unknown) => {
    if (!Array.isArray(servers)) return;
    for (const server of servers) {
      if (!server || typeof server.url !== 'string') continue;
      for (const url of expandServerUrlVariants(server)) {
        const host = absoluteHost(url);
        if (host) hosts.add(host);
      }
    }
  };
  addServers(doc.servers);
  const paths = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
  for (const item of Object.values<any>(paths)) {
    if (!item || typeof item !== 'object') continue;
    addServers(item.servers);
    for (const method of HTTP_METHODS) {
      if (item[method]) addServers(item[method].servers);
    }
  }
  return hosts;
}

/** Hosts declared by the spec in the preview, plus the ones the user allowed for this panel. */
let proxyAllowedHosts = new Set<string>();
const proxyApprovedHosts = new Set<string>();
const proxyPendingApprovals = new Map<string, Thenable<boolean>>();
/** Aborted when the preview is closed, cancelling every request still in flight. */
let proxyLifetime = new AbortController();

/**
 * The webview may only reach the hosts its spec declares. Any other host (a
 * server URL typed in Swagger UI, or a script injected through the spec) needs
 * the user's confirmation once per preview, so the preview cannot be used to
 * probe localhost or the internal network behind the user's back.
 */
async function isProxyHostAllowed(url: URL): Promise<boolean> {
  const host = url.host.toLowerCase();
  if (proxyAllowedHosts.has(host) || proxyApprovedHosts.has(host)) return true;
  let approval = proxyPendingApprovals.get(host);
  if (!approval) {
    approval = vscode.window
      .showWarningMessage(
        `The OpenAPI preview wants to send a request to ${host}, which is not one of the spec's servers. Allow requests to this host while the preview is open?`,
        { modal: true },
        'Allow'
      )
      .then((choice) => {
        proxyPendingApprovals.delete(host);
        if (choice === 'Allow') proxyApprovedHosts.add(host);
        return choice === 'Allow';
      });
    proxyPendingApprovals.set(host, approval);
  }
  return approval;
}

/**
 * Runs a "Try it out" request on behalf of the webview. The webview origin
 * (vscode-webview://…) is cross-origin for every API, so a browser fetch fails
 * CORS unless the server allows it. The extension host has no such restriction.
 */
async function handleProxyMessage(message: ProxyRequest): Promise<void> {
  if (!message || message.type !== 'wrenchit.fetch' || !openApiPanel) return;
  const panel = openApiPanel;
  const reply = await runProxyRequest(message, {
    fetch,
    isHostAllowed: isProxyHostAllowed,
    signal: proxyLifetime.signal
  });
  if (openApiPanel === panel) {
    void panel.webview.postMessage({ type: 'wrenchit.fetchResult', id: message.id, ...reply });
  }
}

/**
 * Accepts an OpenAPI document as JSON, YAML, a JSON string that contains the
 * document, or Grafana-escaped JSON. Returns the spec object Swagger UI can render.
 */
export function parseOpenApiDocument(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) {
    throw new Error('WrenchIT: The editor is empty.');
  }

  const direct = interpretOpenApiText(text);
  if (direct) return direct;

  const cleaned = cleanAndParseJson(text);
  if (cleaned.ok) {
    const spec = asOpenApiSpec(cleaned.value);
    if (spec) return spec;
  }

  throw new Error(
    'WrenchIT: The content is not an OpenAPI/Swagger spec in JSON or YAML. It must include an "openapi" or "swagger" field.'
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

/**
 * Base URL for resolving the spec's $refs inside the webview (never fetched).
 *
 * Swagger UI resolves everything relative against this URL, not only the
 * local "#/…" refs: relative servers ("/api", or the implicit "/" when the
 * spec has none), Swagger 2.0 documents without "host" and external $refs
 * ("./common.yaml#/X"). "Try it out" would send those requests to
 * wrenchit.invalid, so findBaseUrlDependencies() detects them and the
 * preview shows a warning instead of silently pointing nowhere.
 */
export const SPEC_BASE_URL = 'https://wrenchit.invalid/openapi.json';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * True for "https://…" and "//host…". A bare "scheme:" is not enough:
 * "localhost:5080/api" has no "//", so Swagger UI resolves it as a relative path.
 */
function isAbsoluteUrl(url: string): boolean {
  return /^([a-z][a-z0-9+.-]*:\/\/|\/\/)/i.test(url.trim());
}

/**
 * Replaces each "{name}" of a Server Object URL with its variable's default,
 * the value Swagger UI uses. Returns undefined when a variable has no
 * default, since then the final URL cannot be known.
 */
function expandServerUrl(server: Record<string, any>): string | undefined {
  const url: string = server.url;
  const variables = server.variables && typeof server.variables === 'object' ? server.variables : {};
  let unresolved = false;
  const expanded = url.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
    const variable = Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
    if (variable && typeof variable === 'object' && variable.default !== undefined) return String(variable.default);
    unresolved = true;
    return '';
  });
  return unresolved ? undefined : expanded;
}

/** Keys whose content is sample data: a "$ref" inside them is not a reference. */
const DATA_KEYS = new Set(['example', 'examples']);

/**
 * Lists the parts of the spec that Swagger UI would resolve against
 * SPEC_BASE_URL, so they would point at wrenchit.invalid. Each entry is a
 * human-readable description, ready to show in the preview.
 */
export function findBaseUrlDependencies(spec: unknown): string[] {
  if (!spec || typeof spec !== 'object') return [];
  const doc = spec as Record<string, any>;
  const found: string[] = [];

  if (typeof doc.swagger === 'string') {
    if (typeof doc.host !== 'string' || !doc.host.trim()) {
      found.push('The Swagger 2.0 spec does not define "host".');
    }
  } else {
    const relativeIn = (servers: unknown, where: string) => {
      if (!Array.isArray(servers)) return;
      for (const server of servers) {
        if (!server || typeof server.url !== 'string') continue;
        const expanded = expandServerUrl(server);
        // Without a default the final URL is unknown: no warning.
        if (expanded !== undefined && !isAbsoluteUrl(expanded)) {
          found.push(`Relative server "${server.url}" ${where}.`);
        }
      }
    };
    if (!Array.isArray(doc.servers) || doc.servers.length === 0) {
      found.push('The spec does not define "servers" (OpenAPI defaults to "/").');
    } else {
      relativeIn(doc.servers, 'in "servers"');
    }
    const paths = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
    for (const [path, item] of Object.entries<any>(paths)) {
      if (!item || typeof item !== 'object') continue;
      relativeIn(item.servers, `in path ${path}`);
      for (const method of HTTP_METHODS) {
        if (item[method]) relativeIn(item[method].servers, `in ${method.toUpperCase()} ${path}`);
      }
    }
  }

  const externalRefs = new Set<string>();
  const seen = new WeakSet<object>();
  // Each entry carries the key the node hangs from, to tell "example" as sample
  // data apart from a schema property that happens to be called "example".
  const stack: Array<[unknown, string | undefined]> = [[doc, undefined]];
  while (stack.length) {
    const [node, parentKey] = stack.pop()!;
    // YAML anchors (&a … *a) can produce cyclic structures.
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const isPropertyMap = parentKey === 'properties' && !Array.isArray(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') {
        if (!value.startsWith('#') && !isAbsoluteUrl(value)) externalRefs.add(value);
      } else if (DATA_KEYS.has(key) && !isPropertyMap) {
        continue;
      } else if (value && typeof value === 'object') {
        stack.push([value, key]);
      }
    }
  }
  for (const ref of externalRefs) {
    found.push(`Relative external $ref "${ref}" (cannot be loaded from the preview).`);
  }

  return found;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildBaseUrlWarning(spec: unknown): string {
  const issues = findBaseUrlDependencies(spec);
  if (issues.length === 0) return '';
  const host = new URL(SPEC_BASE_URL).host;
  const items = issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('');
  return `<div class="wrenchit-warning" role="alert">
    <strong>Relative URLs resolve against ${host}.</strong>
    The preview has no source URL for the spec, so "Try it out" would send these requests to https://${host}, which does not exist. Use absolute server URLs (e.g. http://localhost:5080/api) to try the API from here.
    <ul>${items}</ul>
  </div>`;
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
  const warningHtml = buildBaseUrlWarning(spec);
  const nonce = crypto.randomBytes(16).toString('base64');

  // BaseLayout: StandaloneLayout draws an "Explore" bar with an empty URL.
  // Clicking it (or pressing Enter) calls download("") and replaces the spec
  // with "Failed to load API definition" / "No API definition provided".
  // validatorUrl null: the webview CSP blocks the remote validator anyway.
  // Initialization does not wait for window.onload: VS Code writes the
  // webview HTML with document.write and that event does not always fire.
  // url plugin: with no spec URL, Swagger UI uses document.baseURI
  // (vscode-webview://…?…) as the base for resolving $refs. The OpenAPI 3.1
  // resolver cannot evaluate "#/components/…" against that URI and fails with
  // "Could not resolve reference: Evaluation failed on URI". A fixed https URL
  // (.invalid domain, never fetched) makes local $refs resolve inside the
  // document itself. Trade-off: relative servers and external $refs also
  // resolve against that URL; see SPEC_BASE_URL and the warning built by
  // buildBaseUrlWarning(). InfoUrl is cleared so the header does not link to
  // that fake URL under the title.
  return `<!DOCTYPE html>
<html lang="en"${htmlClass}>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data: blob:; font-src ${webview.cspSource} data:; connect-src http: https:;">
  <link rel="stylesheet" href="${cssUri}">
  <title>Preview OpenAPI</title>
  <style>
    html { box-sizing: border-box; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; }
    html.dark-mode body { background: #1c2022; }
    .wrenchit-warning { margin: 16px auto 0; max-width: 1460px; padding: 10px 16px; border: 1px solid #e0b252; border-left-width: 4px; border-radius: 4px; background: #fff7e0; color: #3b3b3b; font: 13px/1.5 sans-serif; }
    .wrenchit-warning ul { margin: 6px 0 0; padding-left: 20px; }
    html.dark-mode .wrenchit-warning { background: #3a3220; border-color: #c99a3a; color: #f0e6d0; }
  </style>
</head>
<body>
  ${warningHtml}
  <div id="swagger-ui"></div>
  <script nonce="${nonce}" src="${bundleJsUri}"></script>
  <script nonce="${nonce}">
    // "Try it out" requests go through the extension host: the webview origin
    // is cross-origin for every API, so a direct fetch would fail with CORS.
    var vscodeApi = acquireVsCodeApi();
    var pending = {};
    var nextId = 1;
    window.addEventListener('message', function (event) {
      var m = event.data;
      if (!m || m.type !== 'wrenchit.fetchResult' || !pending[m.id]) return;
      var p = pending[m.id];
      delete pending[m.id];
      if (!m.ok) { p.reject(new TypeError(m.error)); return; }
      // new Response() throws for statuses it cannot represent (1xx, or > 599):
      // reject instead, or Swagger UI would wait for this request forever.
      try {
        var bytes = Uint8Array.from(atob(m.body), function (c) { return c.charCodeAt(0); });
        var noBody = m.status === 204 || m.status === 205 || m.status === 304;
        p.resolve(new Response(noBody ? null : bytes, { status: m.status, statusText: m.statusText, headers: m.headers }));
      } catch (e) {
        p.reject(new TypeError('Cannot show the response (HTTP ' + m.status + '): ' + (e && e.message ? e.message : e)));
      }
    });
    function toBase64(buffer) {
      var bytes = new Uint8Array(buffer), bin = '';
      for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    async function proxyFetch(url, options) {
      options = options || {};
      var headers = {};
      new Headers(options.headers || {}).forEach(function (v, k) { headers[k] = v; });
      var body;
      if (options.body !== undefined && options.body !== null) {
        var carrier = new Response(options.body);
        var type = carrier.headers.get('content-type');
        if (type && !headers['content-type']) headers['content-type'] = type;
        body = toBase64(await carrier.arrayBuffer());
      }
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        vscodeApi.postMessage({ type: 'wrenchit.fetch', id: id, url: String(url), method: options.method || 'GET', headers: headers, body: body });
      });
    }
    window.ui = SwaggerUIBundle({
      requestInterceptor: function (req) { req.userFetch = proxyFetch; return req; },
      spec: ${specJson},
      dom_id: '#swagger-ui',
      deepLinking: false,
      presets: [SwaggerUIBundle.presets.apis],
      plugins: [function () {
        return {
          statePlugins: { spec: { wrapSelectors: {
            url: function () { return function () { return ${embedJsonForScript(SPEC_BASE_URL)}; }; }
          } } },
          components: { InfoUrl: function () { return null; } }
        };
      }],
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
