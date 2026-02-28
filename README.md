# WrenchIT

Extensión de Visual Studio Code con utilidades rápidas para desarrolladores: codificación Base64 y limpieza de JSON corrupto (especialmente el que genera Grafana).

## Comandos

Todos los comandos están disponibles desde la **paleta de comandos** (`Ctrl+Shift+P`) y en el **menú contextual** del editor (clic derecho).

---

### WrenchIT: Codificar en Base64

Codifica el texto seleccionado en Base64 (UTF-8).

**Uso:** selecciona el texto → clic derecho → _WrenchIT: Codificar en Base64_

---

### WrenchIT: Decodificar Base64

Decodifica el texto seleccionado desde Base64 a texto plano.

**Uso:** selecciona el texto Base64 → clic derecho → _WrenchIT: Decodificar Base64_

---

### WrenchIT: Limpiar y formatear JSON (Grafana)

Limpia y formatea JSON corrupto. Funciona sobre la **selección activa** o, si no hay selección, sobre **todo el documento**.

El JSON que exporta Grafana suele llegar con múltiples capas de corrupción. La extensión aplica un pipeline de limpieza en orden hasta obtener JSON válido:

- Elimina BOM y saltos de línea Windows
- Desenvuelve capas extra de comillas (`"..."`)
- Elimina los delimitadores de barra que Grafana añade alrededor de strings (`///"key///"`, `/"value/"`, `:///"val///"`)
- Deshace múltiples niveles de escape de comillas (`\"`, `\\"`, `\\\"`)
- Convierte valores string que contienen JSON anidado sin escapar en objetos reales (`"Content":"{"key":"val"}"` → `"Content":{"key":"val"}`)
- Elimina barras residuales al final de strings (`"CommerceId/"` → `"CommerceId"`)
- Elimina comas finales inválidas antes de `}` o `]`

Si tras aplicar todas las estrategias el resultado sigue siendo JSON inválido, **el contenido se reemplaza igualmente** con el mejor intento de limpieza y se muestra una advertencia, para que puedas ver qué queda por corregir.

**Uso:** abre el JSON en un editor → clic derecho → _WrenchIT: Limpiar y formatear JSON (Grafana)_

---

## Instalación local

```bash
npm install
npm run compile
npx vsce package --allow-missing-repository --skip-license
# Instalar el .vsix generado:
# Extensions: Install from VSIX...
```

## Requisitos

- Visual Studio Code 1.85 o superior
