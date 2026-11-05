# WrenchIT

A Visual Studio Code extension with quick developer utilities: Base64 encoding, JWT decoding, cleanup of broken JSON (especially the kind Grafana produces) and OpenAPI spec previews with Swagger UI.

## Commands

All commands are available from the **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) and from the editor **context menu** (right-click).

---

### WrenchIT: Encode Base64

Encodes the selected text as Base64 (UTF-8).

**Usage:** select the text → right-click → _WrenchIT: Encode Base64_

---

### WrenchIT: Decode Base64

Decodes the selected Base64 text back to plain text.

**Usage:** select the Base64 text → right-click → _WrenchIT: Decode Base64_

---

### WrenchIT: Decode JWT

Replaces the selected JSON Web Token with its decoded header and payload, as formatted JSON (`{"header": …, "payload": …}`). The signature is not verified.

**Usage:** select the token → right-click → _WrenchIT: Decode JWT_

---

### WrenchIT: Clean Up and Format JSON (Grafana)

Cleans up and formats broken JSON. It works on the **active selection** or, if nothing is selected, on the **whole document**.

JSON exported from Grafana often arrives with several layers of corruption. The extension runs a cleanup pipeline, in order, until it gets valid JSON:

- Removes the BOM and Windows line endings
- Unwraps extra layers of quotes (`"..."`)
- Removes the slash delimiters Grafana adds around strings (`///"key///"`, `/"value/"`, `:///"val///"`)
- Undoes several levels of escaped quotes (`\"`, `\\"`, `\\\"`)
- Removes the quotes Grafana leaves stuck to braces and brackets (`"{` → `{`, `}"` → `}`, `"[` → `[`, `]"` → `]`) and unwraps string values whose content is an object or an array (`"{\"id\":150.0}"` → `{"id":150.0}`), without breaking inner quotes such as `"hello \"world\""`
- Removes leftover trailing slashes in strings (`"CommerceId/"` → `"CommerceId"`)
- Removes invalid trailing commas before `}` or `]`

Numbers keep their original form (`150.0` stays `150.0`), because formatting works on the text instead of re-serializing it.

If the result is still invalid JSON after every strategy, **the content is replaced anyway** with the best cleanup attempt and a warning is shown, so you can see what is left to fix.

**Usage:** open the JSON in an editor → right-click → _WrenchIT: Clean Up and Format JSON (Grafana)_

---

### WrenchIT: Preview OpenAPI (Swagger UI)

Renders an OpenAPI/Swagger spec (JSON or YAML) in a Swagger UI panel next to the editor. It works on the **active selection** or, if nothing is selected, on the **whole document**.

It accepts JSON, YAML, a JSON string that contains the spec and, if the text comes escaped from Grafana, the same cleaner as _Clean Up and Format JSON_. The spec must include an `openapi` or `swagger` field. Running the command again refreshes the panel that is already open.

The preview has no source URL for the spec, so relative server URLs (or a Swagger 2.0 spec without `host`) would make "Try it out" send requests to a placeholder host. The panel shows a warning when that happens; use absolute server URLs (e.g. `http://localhost:5080/api`) to call the API from the preview.

**Usage:** open the OpenAPI spec in an editor → right-click → _WrenchIT: Preview OpenAPI (Swagger UI)_

---

## Building locally

```bash
npm install
npm run compile
npm test
npx vsce package --allow-missing-repository --skip-license
# Install the generated .vsix:
# Extensions: Install from VSIX...
```

## Requirements

- Visual Studio Code 1.85 or later
