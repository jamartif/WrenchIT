const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('module');

const vscodeMock = {
  Uri: {
    joinPath: (base, ...parts) => ({
      path: [base && base.path, ...parts].filter(Boolean).join('/')
    })
  },
  window: {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 }
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'vscode') return vscodeMock;
  return originalRequire.apply(this, arguments);
};

const {
  cleanAndParseJson,
  formatJsonText,
  buildSwaggerUiHtml,
  parseOpenApiDocument
} = require('../out/extension.js');

function cleaned(raw) {
  const result = cleanAndParseJson(raw);
  assert.equal(result.ok, true, `${result.error}\n---\n${result.bestAttempt}`);
  return result.bestAttempt;
}

function formatted(raw) {
  return formatJsonText(cleaned(raw));
}

test('preserves decimal notation while formatting plain JSON', () => {
  const out = formatted('{"n":150.0,"ok":true}');
  assert.match(out, /150\.0/);
  assert.deepEqual(JSON.parse(out), { n: 150, ok: true });
});

test('promotes stringified objects and arrays left by Grafana, including 150.0', () => {
  // A Loki line: the log payload and its "response" field are JSON strings.
  const response = JSON.stringify({ id: 'ord_123', items: [{ sku: 'A-1', qty: 2 }] });
  const line = `{"ts":"2024-03-09T12:34:56.789Z","msg":"request completed","status":200,"duration":150.0,"request":{"method":"POST","path":"/v1/orders"},"response":${JSON.stringify(response)}}`;
  const loki = `{"stream":{"app":"api"},"line":${JSON.stringify(line)}}`;

  const out = formatted(loki);
  assert.match(out, /150\.0/);
  const value = JSON.parse(out);
  assert.equal(value.line.duration, 150);
  assert.equal(value.line.response.id, 'ord_123');
  assert.deepEqual(value.line.response.items, [{ sku: 'A-1', qty: 2 }]);
  assert.equal(out.includes('"{'), false);
  assert.equal(out.includes('}"'), false);
  assert.equal(out.includes('["'), false);
  assert.equal(out.includes(']"'), false);
});

test('strips quotes glued to braces in a pretty-printed Grafana value', () => {
  const raw = `{
  "Content": "{
    "key": "val",
    "list": [
      "a",
      "b"
    ]
  }"
}`;
  const value = JSON.parse(cleaned(raw));
  assert.deepEqual(value, { Content: { key: 'val', list: ['a', 'b'] } });
});

test('unwraps nested escaped containers and keeps internal quotes', () => {
  const pretty = JSON.stringify({
    level: 'info',
    msg: 'hello "world"',
    items: JSON.stringify([{ id: 1 }])
  }, null, 2);
  const raw = `"${pretty.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  const out = formatted(raw);
  const value = JSON.parse(out);
  assert.equal(value.msg, 'hello "world"');
  assert.deepEqual(value.items, [{ id: 1 }]);
  assert.match(out, /hello \\"world\\"/);
});

test('unwraps a double-encoded Grafana document down to real containers', () => {
  const doc = {
    level: 'error',
    payload: JSON.stringify({
      user: 'ada',
      roles: JSON.stringify(['admin'])
    })
  };
  const raw = JSON.stringify(JSON.stringify(doc));
  const value = JSON.parse(cleaned(raw));
  assert.deepEqual(value, {
    level: 'error',
    payload: { user: 'ada', roles: ['admin'] }
  });
});

test('promotes empty containers and stringified arrays, preserving 150.0', () => {
  const raw = '{"tags":"[\\"admin\\",\\"dev\\"]","empty":"{}","arrEmpty":"[]","n":150.0}';
  const out = formatted(raw);
  assert.match(out, /150\.0/);
  assert.deepEqual(JSON.parse(out), {
    tags: ['admin', 'dev'],
    empty: {},
    arrEmpty: [],
    n: 150
  });
});

test('promotes containers wrapped with whitespace', () => {
  const raw = '{"body":" { \\"id\\": 150.0 } ","tags":" [ \\"a\\" ] "}';
  const out = formatted(raw);
  assert.match(out, /150\.0/);
  assert.deepEqual(JSON.parse(out), { body: { id: 150 }, tags: ['a'] });
});

test('does not strip quotes that belong to ordinary strings', () => {
  const raw = '{"msg":"use {braces} and arrays a[0] ends with }","note":"see ] later","broken":"{not json}","almost":"[not an array]","n":150.0}';
  const out = formatted(raw);
  const value = JSON.parse(out);
  assert.equal(value.msg, 'use {braces} and arrays a[0] ends with }');
  assert.equal(value.note, 'see ] later');
  assert.equal(value.broken, '{not json}');
  assert.equal(value.almost, '[not an array]');
  assert.match(out, /150\.0/);
});

test('still cleans symmetrical Grafana slash wrapping', () => {
  const raw = '{/"level/":/"info/",/"body/":/"{/"id/":150.0}/"}';
  const out = formatted(raw);
  assert.match(out, /150\.0/);
  assert.deepEqual(JSON.parse(out), { level: 'info', body: { id: 150 } });
});

test('keeps URLs and removes only the Grafana trailing-slash artifact', () => {
  const raw = '{"url":"https://example.com/a/","id":"CommerceId/",}';
  const value = JSON.parse(cleaned(raw));
  assert.equal(value.url, 'https://example.com/a/');
  assert.equal(value.id, 'CommerceId');
});

test('removes trailing commas and double-wrapped strings', () => {
  const raw = '{"a":""hello"","n":150.0,}';
  const out = formatted(raw);
  assert.match(out, /150\.0/);
  assert.deepEqual(JSON.parse(out), { a: 'hello', n: 150 });
});

function webviewHtml(spec, darkMode = false) {
  const webview = {
    cspSource: 'https://webview.test',
    asWebviewUri: (uri) => ({ toString: () => `https://webview.test${uri.path}` })
  };
  const context = { extensionUri: { path: '/ext' } };
  return buildSwaggerUiHtml(webview, context, spec, darkMode);
}

function readSwaggerConfig(html) {
  const marker = 'SwaggerUIBundle({';
  const callAt = html.indexOf(marker);
  assert.ok(callAt > 0, 'missing SwaggerUIBundle init');
  const scriptStart = html.lastIndexOf('<script>', callAt);
  const closer = /<\/script\s*>/i.exec(html.slice(callAt));
  assert.ok(closer, 'script never closes');
  const body = html.slice(scriptStart + '<script>'.length, callAt + closer.index);
  assert.equal(/<\/script/i.test(body), false, 'spec broke out of the script element');

  let captured;
  function SwaggerUIBundle(config) {
    captured = config;
    return {};
  }
  SwaggerUIBundle.presets = { apis: { name: 'apis' } };
  const run = new Function('SwaggerUIBundle', 'window', body);
  run(SwaggerUIBundle, {});
  assert.ok(captured, 'init script did not call SwaggerUIBundle');
  return captured;
}

test('Swagger preview survives HTML in the spec and does not use the Explore layout', () => {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'Demo',
      version: '1.0.0',
      description: 'Ejemplo con </script>, </SCRIPT> y </script > más un salto\u2028de línea'
    },
    paths: { '/users': { get: { responses: { '200': { description: 'ok' } } } } }
  };
  const html = webviewHtml(spec, true);
  const config = readSwaggerConfig(html);

  assert.equal(config.layout, 'BaseLayout');
  assert.equal(config.validatorUrl, null);
  assert.equal(config.deepLinking, false);
  assert.equal(config.spec.info.description, spec.info.description);
  assert.equal(html.includes('StandaloneLayout'), false);
  assert.equal(html.includes('swagger-ui-standalone-preset'), false);
  assert.equal(html.includes('window.onload'), false);
  assert.match(html, /connect-src http: https:/);
  assert.match(html, /<html lang="es" class="dark-mode">/);
  assert.match(config.oauth2RedirectUrl, /oauth2-redirect\.html$/);
  assert.match(webviewHtml(spec, false), /<html lang="es">/);
});

test('parseOpenApiDocument reads JSON, YAML, BOM, JSON strings and trailing commas', () => {
  const json = '{"openapi":"3.0.3","info":{"title":"JSON","version":"1.0.0"},"paths":{}}';
  assert.equal(parseOpenApiDocument(json).info.title, 'JSON');
  assert.equal(parseOpenApiDocument(`\uFEFF${json}`).info.title, 'JSON');
  assert.equal(parseOpenApiDocument(JSON.stringify(json)).info.title, 'JSON');

  const yaml = `openapi: 3.0.3
info:
  title: YAML Demo
  version: "1.2.3"
  description: |
    Texto con </SCRIPT> y dos líneas
paths:
  /users:
    get:
      summary: List users
      responses:
        "200":
          description: ok
`;
  const fromYaml = parseOpenApiDocument(yaml);
  assert.equal(fromYaml.info.title, 'YAML Demo');
  assert.match(fromYaml.info.description, /<\/SCRIPT>/);
  assert.equal(fromYaml.paths['/users'].get.summary, 'List users');

  const trailing = '{"openapi":"3.0.3","info":{"title":"Comas","version":"1"},"paths":{},}';
  assert.equal(parseOpenApiDocument(trailing).info.title, 'Comas');

  const swagger2 = 'swagger: "2.0"\ninfo:\n  title: Legacy\n  version: "1"\npaths: {}\n';
  assert.equal(parseOpenApiDocument(swagger2).swagger, '2.0');
  assert.equal(parseOpenApiDocument(swagger2).info.title, 'Legacy');
});

test('parseOpenApiDocument rejects text that is not a spec', () => {
  assert.throws(() => parseOpenApiDocument('{"hello":"world"}'), /openapi/);
  assert.throws(() => parseOpenApiDocument('just text'), /openapi/);
  assert.throws(() => parseOpenApiDocument('   '), /vacío/);
});
