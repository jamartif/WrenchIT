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

Los comandos Base64 y `decodeJwt` requieren selección. `fixJson` opera sobre la selección si la hay o sobre el documento completo en caso contrario.

Los cuatro comandos aparecen en el menú contextual del editor; Base64 y JWT solo cuando hay selección (`when: editorHasSelection`).

### Comando `fixJson` — pipeline de limpieza

La función `cleanAndParseJson()` prueba estrategias en orden hasta que `JSON.parse()` tenga éxito. Si ninguna funciona, reemplaza el contenido con el último intento para que el usuario pueda inspeccionarlo.

| # | Estrategia |
|---|------------|
| 1 | Texto tal cual |
| 2 | Trim |
| 3 | `tryUnwrapString` — desenvuelve capa exterior `"…"` vía `JSON.parse` |
| 4 | `wrapAndUnescape` — envuelve en comillas para que el motor desescapee `\"` en un solo paso; falla si el texto contiene comillas sin escapar |
| 5 | Eliminación de barras antes de comillas (sin contexto URL) + `\"` → `"` |
| 6 | Eliminación de barras simétricas `/"key/"` en ambos lados |
| 7 | `grafanaDeepClean` — BOM, CRLF, desescapado multi-nivel, trailing commas, `unquoteJsonStringValues` |
| 8 | `grafanaDeepClean` + `tryUnwrapString` combinados |

#### Helpers clave del pipeline

- **`tryUnwrapString`** — si el string empieza y termina con `"`, usa `JSON.parse` para desescapar; hace fallback a recorte manual.
- **`grafanaDeepClean`** — limpiador multi-paso: BOM → CRLF → unwrap (dos niveles) → barras simétricas → barras asimétricas → desescapado iterativo (máx. 5 pasadas) → segunda pasada de barras → trailing slash en valores → `unquoteJsonStringValues` → contenedores vacíos como string → dobles comillas exteriores → trailing commas.
- **`unquoteJsonStringValues`** — elimina las comillas que envuelven valores que son objetos/arrays JSON sin escapar (p. ej. `"Content":"{"k":"v"}"` → `"Content":{"k":"v"}`). Itera hasta estabilización.

#### Formateador de texto `formatJsonText`

Formatea JSON con 2 espacios de indentación **trabajando a nivel de texto**, sin pasar por `JSON.parse` → `JSON.stringify`. Esto preserva representaciones numéricas como `150.0`. Los contenedores vacíos (`{}`, `[]`) se emiten en una sola línea.

## Release

El workflow `.github/workflows/build.yml` se dispara en dos situaciones:

- **Push a `main`**: compila y sube el `.vsix` como artefacto de CI (90 días de retención), pero no crea release.
- **Push de tag `vX.Y.Z`**: además sincroniza la versión en `package.json` y adjunta el `.vsix` al GitHub Release (lo crea si no existe).
