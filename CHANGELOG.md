# Changelog

## 1.2.8

- OpenAPI preview: "Try it out" no longer hangs when the server answers with a 1xx status or never answers. Requests are cancelled after 30 seconds or when the preview is closed.
- OpenAPI preview: requests to hosts that are not in the spec's servers ask for confirmation first, and request and response bodies are limited to 20 MB.
- OpenAPI preview: inline scripts run with a per-render nonce instead of `unsafe-inline`.

## 1.2.7

- OpenAPI preview: "Try it out" requests are now sent by the extension host instead of the webview, so they no longer fail with CORS errors.

## 1.2.6

- Everything is in English: command titles, messages and the OpenAPI preview warning.
- New extension icon.
- MIT license, third-party notices and full Marketplace metadata (repository, issues, homepage, keywords).

## 1.2.5

- Published under the `jamartif` Marketplace publisher (extension ID `jamartif.wrenchit`).

## 1.2.4

- OpenAPI preview: a server URL only counts as absolute with `://` (so `localhost:5080/api` now warns), server variables are expanded with their defaults before the check, and the `$ref` walk terminates on cyclic specs and ignores `$ref` inside `example` / `examples`.

## 1.2.3

- OpenAPI preview: warns when relative servers, a Swagger 2.0 spec without `host` or relative external `$ref`s would make "Try it out" call a placeholder host.

## 1.2.2

- OpenAPI preview: local `$ref`s resolve correctly inside the webview.

## 1.2.1

- Clean Up and Format JSON: unwraps the quotes Grafana leaves around objects and arrays; OpenAPI preview fixes.

## 1.2.0

- New command: Preview OpenAPI (Swagger UI).

Earlier versions: see [GitHub Releases](https://github.com/jamartif/WrenchIT/releases).
