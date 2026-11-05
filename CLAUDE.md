# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Typecheck + bundle (esbuild, includes js-yaml) + Swagger UI assets → out/
npm run compile

# Tests (node:test)
npm test

# Compile in watch mode
npm run watch

# Package the extension as a .vsix
npx vsce package --allow-missing-repository --skip-license
```

Pure-logic tests live in `test/` and run with `npm test` (no extension host needed). To try the UI: `F5` in VS Code opens an Extension Development Host window.

## Language

Everything in the repository is in English: README, CLAUDE.md, `package.json` descriptions and command titles, user-facing messages, code comments, tests and commit messages.

## Architecture

A VS Code extension with a single source file (`src/extension.ts`). `tsc --noEmit` checks types and esbuild bundles `out/extension.js` (CommonJS, with `js-yaml` bundled and `vscode` external).

### Data flow

- `activate()` registers the five commands.
- `getEditorAndSelection()` returns the active editor + selection (shared helper).
- `replaceSelection()` / `replaceWholeDocument()` apply edits through `editor.edit()`.

The Base64 commands and `decodeJwt` require a selection. `fixJson` and `previewOpenApi` work on the selection if there is one, or on the whole document otherwise.

All five commands appear in the editor context menu; Base64 and JWT only when there is a selection (`when: editorHasSelection`).

### `fixJson` command — cleanup pipeline

`cleanAndParseJson()` tries strategies in order until `JSON.parse()` succeeds. If none works, it replaces the content with the last attempt so the user can inspect it.

| # | Strategy |
|---|----------|
| 1 | Text as is |
| 2 | Trim |
| 3 | `tryUnwrapString` — unwraps an outer `"…"` layer through `JSON.parse` |
| 4 | `wrapAndUnescape` — wraps the text in quotes so the engine unescapes `\"` in one step; fails if the text contains unescaped quotes |
| 5 | Removes slashes before quotes (outside URL context) + `\"` → `"` |
| 6 | Removes symmetric slashes `/"key/"` on both sides |
| 7 | `grafanaDeepClean` — BOM, CRLF, multi-level unescaping, trailing commas, `unquoteJsonStringValues` |
| 8 | `grafanaDeepClean` + `tryUnwrapString` combined |

When a strategy produces text that `JSON.parse` accepts, `finalizeJsonText` also unwraps a document that is a JSON string and promotes string values whose content is an object or array (`"{...}"`, `"[...]"`), working on the text so `150.0` is not lost. `grafanaDeepClean` strips those quotes with `stripQuotedContainers` and unescapes inner quotes one layer at a time (`unescapeOneLayer`), stopping as soon as the document is valid.

#### Key pipeline helpers

- **`tryUnwrapString`** — if the string starts and ends with `"`, uses `JSON.parse` to unescape it; falls back to trimming by hand.
- **`grafanaDeepClean`** — multi-step cleaner: BOM → CRLF → unwrap (two levels) → symmetric slashes → asymmetric slashes → iterative unescaping (max. 5 passes) → second slash pass → trailing slash in values → `unquoteJsonStringValues` → empty containers as strings → outer double quotes → trailing commas.
- **`unquoteJsonStringValues`** — removes the quotes around values that are unescaped JSON objects/arrays (e.g. `"Content":"{"k":"v"}"` → `"Content":{"k":"v"}`). Iterates until stable.

#### Text formatter `formatJsonText`

Formats JSON with 2-space indentation **working on the text**, without going through `JSON.parse` → `JSON.stringify`. This preserves number representations such as `150.0`. Empty containers (`{}`, `[]`) are emitted on one line.

### `previewOpenApi` command

`parseOpenApiDocument()` accepts JSON, YAML, a JSON string containing the spec, or Grafana-escaped text (through the `fixJson` cleaner). `buildSwaggerUiHtml()` renders Swagger UI in a webview with the spec embedded and resolved against `SPEC_BASE_URL` (`https://wrenchit.invalid/openapi.json`, never fetched). `findBaseUrlDependencies()` lists what would resolve against that placeholder (relative servers after expanding variable defaults, Swagger 2.0 without `host`, relative external `$ref`s) and the preview shows an HTML-escaped warning for them.

## Release

The `.github/workflows/build.yml` workflow runs in three cases:

- **Push to `main`**: builds and uploads the `.vsix` as a CI artifact (90-day retention), but does not create a release.
- **Push of a `vX.Y.Z` tag**: also syncs the version in `package.json` and attaches the `.vsix` to the GitHub Release (creating it if needed).
- **Manual run (`workflow_dispatch`) with `version`**: creates a draft release `vX.Y.Z` on the `main` commit. Publishing it creates the tag, and that push builds and attaches the `.vsix`.

The Marketplace publisher is `jamartif`, so the extension ID is `jamartif.wrenchit`.
