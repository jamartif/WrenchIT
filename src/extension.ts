import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('wrenchit.encodeBase64', () => encodeBase64()),
    vscode.commands.registerCommand('wrenchit.decodeBase64', () => decodeBase64()),
    vscode.commands.registerCommand('wrenchit.fixJson', () => fixJson())
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

  const formatted = JSON.stringify(result.value, null, 2);

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
function cleanAndParseJson(raw: string): ParseResult {
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
    // 6. Symmetrical slash-wrapping on both sides of strings:
    //    /"key/"  //"val//"  ///"x///"  \/"k\/"  \\/"v\\/"  (and mixed)
    //    Requires slashes on BOTH sides, so URLs with a trailing / are safe.
    //    Note: : excluded from lookbehind because :///"val///" is a Grafana pattern,
    //    not a URL (real URLs have :// followed by domain letters, never by ").
    s => s.trim().replace(/(?<![A-Za-z0-9._-])[\\/]+(")([^"]*?)[\\/]+(")/g, '$1$2$3'),
    // 7. Full Grafana deep-clean (multi-pass, all patterns)
    s => grafanaDeepClean(s.trim()),
    // 8. Deep-clean + unwrap (for double-wrapped content)
    s => tryUnwrapString(grafanaDeepClean(s.trim())),
  ];

  let bestAttempt = raw;

  for (const strategy of strategies) {
    try {
      const cleaned = strategy(raw);
      bestAttempt = cleaned; // guardar el último intento aunque falle
      const parsed = JSON.parse(cleaned);
      return { ok: true, value: parsed, bestAttempt: cleaned };
    } catch {
      // try next strategy
    }
  }

  return {
    ok: false,
    error: 'Ninguna estrategia de limpieza produjo JSON válido.',
    bestAttempt
  };
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

        // Only strip if the closing bracket is immediately followed by "
        if (closePos + 1 < result.length && result[closePos + 1] === '"') {
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
  result = result.replace(/(?<![A-Za-z0-9._-])[\\/]+(")([^"]*?)[\\/]+(")/g, '$1$2$3');

  // Remove forward slashes immediately before a double-quote when they are
  // NOT part of a URL (i.e. not preceded by letters, digits, dot…).
  // Covers:  /"key"  ///"key"  \/"key"  :///"val"  and similar Grafana artifacts.
  result = result.replace(/(?<![A-Za-z0-9._-])[\\/]+(?=")/g, '')
            .replace('///"','"')
            .replace('//"','"')
            .replace('/"','"');

  // Multi-pass unescape: each iteration strips one layer of backslash escaping.
  // Handles \" → "  and  \\\" → \"  → "  across multiple levels.
  // Also cleans \/ → /  and \\ → \ (leftover after forward-slash removal).
  let prev = '';
  let iterations = 0;
  while (prev !== result && iterations < 5) {
    prev = result;
    result = result
      .replace(/\\"/g,  '"')   // \" → "
      .replace(/\\\//g, '/')   // \/ → /
      .replace(/\\\\/g, '\\'); // \\ → \
    iterations++;
  }

  // Second slash-removal pass: the unescape above can reveal new /" sequences
  // (e.g. /\" → /" after the first iteration). Remove them the same way.
  result = result.replace(/(?<![A-Za-z0-9._-])[\\/]+(")([^"]*?)[\\/]+(")/g, '$1$2$3');
  result = result.replace(/(?<![A-Za-z0-9._-])[\\/]+(?=")/g, '');

  // Remove trailing slashes inside JSON string values (Grafana delimiter artifact):
  //   "CommerceId/"  →  "CommerceId"    "xxx/"  →  "xxx"
  // The regex only matches when the content contains NO other slashes, so URLs
  // ("https://example.com/") and paths ("/some/path/") are left untouched.
  result = result.replace(/"([^"/]*)\/+"/g, '"$1"');

  // Unquote string values that contain unescaped JSON objects/arrays:
  //   "Content":"{"key":"val"}" → "Content":{"key":"val"}
  // Grafana sometimes stores nested JSON as an unescaped string value.
  result = unquoteJsonStringValues(result);

  // Second trailing-slash pass after unquoting (new content may have been revealed).
  result = result.replace(/"([^"/]*)\/+"/g, '"$1"');

  // Strip outer quotes wrapping the whole document:
  //   "{"key":"val"}" → {"key":"val"}
  //   "["item"]"      → ["item"]
  result = result.replace(/^"(\{[\s\S]*\})"$/, '$1')
                 .replace(/^"(\[[\s\S]*\])"$/, '$1');

  // Remove trailing commas before } or ] (invalid JSON but common in pastes)
  result = result.replace(/,\s*([}\]])/g, '$1');

  return result;
}
