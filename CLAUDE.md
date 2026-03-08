# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Compilar TypeScript → out/
npm run compile

# Compilar en modo watch
npm run watch

# Empaquetar extensión como .vsix
npx vsce package --allow-missing-repository --skip-license
```

No hay suite de tests. Para probar manualmente: `F5` en VS Code abre una ventana de extensión en modo Development Host.

## Arquitectura

Extensión de VS Code de un único fichero fuente (`src/extension.ts`). TypeScript compilado a `out/extension.js` (CommonJS, ES2020).

### Flujo de datos

- `activate()` registra los tres comandos.
- `getEditorAndSelection()` obtiene editor activo + selección (helper compartido).
- `replaceSelection()` / `replaceWholeDocument()` aplican ediciones vía `editor.edit()`.

### Comando `fixJson` — pipeline de limpieza

La función `cleanAndParseJson()` prueba estrategias en orden hasta que `JSON.parse()` tenga éxito:

1. Texto tal cual
2. Trim
3. `tryUnwrapString` — desenvuelve capa exterior `"…"` vía `JSON.parse`
4. `wrapAndUnescape` — envuelve en comillas para que el motor desescapee `\"`
5. Eliminación de barras antes de comillas (sin contexto URL)
6. Eliminación de barras simétricas `/"key/"` en ambos lados
7. `grafanaDeepClean` — BOM, CRLF, desescapado multi-nivel, trailing commas, `unquoteJsonStringValues`
8. `grafanaDeepClean` + `tryUnwrapString` combinados

El formateado final usa `formatJsonText()`, un formateador a nivel de texto que **no pasa por `JSON.parse` → `JSON.stringify`**, preservando así representaciones numéricas como `150.0`.

## Release

Empujar un tag `vX.Y.Z` dispara el workflow `.github/workflows/build.yml`, que sincroniza la versión en `package.json`, empaqueta el `.vsix` y lo adjunta al GitHub Release (lo crea si no existe).
