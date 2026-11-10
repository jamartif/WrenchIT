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
  parseOpenApiDocument,
  findBaseUrlDependencies,
  SPEC_BASE_URL,
  runProxyRequest,
  collectSpecHosts,
  describeError
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
  const scriptTag = html.lastIndexOf('<script', callAt);
  const scriptStart = html.indexOf('>', scriptTag) + 1;
  const closer = /<\/script\s*>/i.exec(html.slice(callAt));
  assert.ok(closer, 'script never closes');
  const body = html.slice(scriptStart, callAt + closer.index);
  assert.equal(/<\/script/i.test(body), false, 'spec broke out of the script element');

  let captured;
  function SwaggerUIBundle(config) {
    captured = config;
    return {};
  }
  SwaggerUIBundle.presets = { apis: { name: 'apis' } };
  const run = new Function('SwaggerUIBundle', 'window', 'acquireVsCodeApi', body);
  const listeners = {};
  const posted = [];
  run(
    SwaggerUIBundle,
    { addEventListener(type, fn) { listeners[type] = fn; } },
    () => ({ postMessage(m) { posted.push(m); } })
  );
  assert.ok(captured, 'init script did not call SwaggerUIBundle');
  Object.defineProperty(captured, '__webview', { value: { listeners, posted }, enumerable: false });
  return captured;
}

test('Swagger preview survives HTML in the spec and does not use the Explore layout', () => {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'Demo',
      version: '1.0.0',
      description: 'Example with </script>, </SCRIPT> and </script > plus a line\u2028separator'
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
  assert.match(html, /<html lang="en" class="dark-mode">/);
  assert.match(config.oauth2RedirectUrl, /oauth2-redirect\.html$/);
  assert.match(webviewHtml(spec, false), /<html lang="en">/);
});

test('Swagger preview resolves local $refs against a fixed https base, not the webview URL', () => {
  const spec = {
    openapi: '3.1.1',
    info: { title: 'Refs', version: '1.0.0' },
    paths: {},
    components: { schemas: { R: { type: 'object' } } }
  };
  const config = readSwaggerConfig(webviewHtml(spec));
  assert.ok(Array.isArray(config.plugins) && config.plugins.length === 1);
  const plugin = config.plugins[0]();
  const wrapUrl = plugin.statePlugins.spec.wrapSelectors.url;
  const url = wrapUrl(() => '')();
  assert.equal(url, SPEC_BASE_URL);
  assert.equal(plugin.components.InfoUrl(), null);
  assert.match(new URL('#/components/schemas/R', url).href, /^https:\/\/wrenchit\.invalid\/openapi\.json#/);
});

test('Swagger preview warns when relative servers would resolve against wrenchit.invalid', () => {
  const op = { get: { responses: { '200': { description: 'ok' } } } };
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Relative', version: '1.0.0' },
    servers: [{ url: '/api' }],
    paths: { '/users': op }
  };

  // Chosen behaviour: Swagger UI resolves "/api" against the fixed base, so
  // "Try it out" would go to wrenchit.invalid. We pin that and warn about it.
  assert.equal(new URL('/api/users', SPEC_BASE_URL).href, 'https://wrenchit.invalid/api/users');
  assert.deepEqual(findBaseUrlDependencies(spec), ['Relative server "/api" in "servers".']);

  const html = webviewHtml(spec);
  assert.match(html, /class="wrenchit-warning"/);
  assert.match(html, /Relative server &quot;\/api&quot; in &quot;servers&quot;/);
  assert.match(html, /https:\/\/wrenchit\.invalid/);
  readSwaggerConfig(html);

  const absolute = { ...spec, servers: [{ url: 'http://localhost:5080/api' }, { url: '{scheme}://example.com' }] };
  assert.deepEqual(findBaseUrlDependencies(absolute), []);
  assert.equal(webviewHtml(absolute).includes('class="wrenchit-warning"'), false);
});

test('findBaseUrlDependencies covers missing servers, path/operation servers, Swagger 2.0 and external refs', () => {
  const info = { title: 't', version: '1' };
  assert.equal(findBaseUrlDependencies({ openapi: '3.1.0', info, paths: {} }).length, 1);
  assert.deepEqual(
    findBaseUrlDependencies({
      openapi: '3.1.0',
      info,
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/a': {
          servers: [{ url: 'v2' }],
          post: {
            servers: [{ url: '/op' }],
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: './common.yaml#/X' } } } } }
          }
        },
        '/b': { get: { responses: { '200': { $ref: '#/components/responses/Ok' } } } }
      }
    }),
    [
      'Relative server "v2" in path /a.',
      'Relative server "/op" in POST /a.',
      'Relative external $ref "./common.yaml#/X" (cannot be loaded from the preview).'
    ]
  );
  assert.equal(findBaseUrlDependencies({ swagger: '2.0', info, basePath: '/v2', paths: {} }).length, 1);
  assert.deepEqual(findBaseUrlDependencies({ swagger: '2.0', info, host: 'api.example.com', paths: {} }), []);

  const html = webviewHtml({ openapi: '3.0.3', info, servers: [{ url: '/<img src=x onerror=alert(1)>' }], paths: {} });
  assert.equal(html.includes('<img src=x'), false);
});

test('findBaseUrlDependencies needs "://" and expands server variables before deciding', () => {
  const info = { title: 't', version: '1' };
  const servers = (list) => findBaseUrlDependencies({ openapi: '3.0.3', info, servers: list, paths: {} });

  // "localhost:" is not a scheme: without "//" Swagger UI treats it as a relative path.
  assert.deepEqual(servers([{ url: 'localhost:5080/api' }]), ['Relative server "localhost:5080/api" in "servers".']);
  assert.deepEqual(servers([{ url: '//api.example.com' }]), []);

  assert.deepEqual(servers([{ url: '{basePath}/v1', variables: { basePath: { default: '/api' } } }]), [
    'Relative server "{basePath}/v1" in "servers".'
  ]);
  assert.deepEqual(
    servers([{ url: '{scheme}://{host}/v1', variables: { scheme: { default: 'https' }, host: { default: 'example.com' } } }]),
    []
  );
  // Without a default the final URL cannot be known: no warning.
  assert.deepEqual(servers([{ url: '{scheme}://example.com' }]), []);
});

test('findBaseUrlDependencies terminates on cyclic specs and ignores $ref inside examples', () => {
  const info = { title: 't', version: '1' };
  const schema = { type: 'object', properties: {} };
  schema.properties.self = schema;
  const spec = { openapi: '3.0.3', info, servers: [{ url: 'https://api.example.com' }], paths: {}, components: { schemas: { Node: schema } } };
  spec.components.root = spec;
  assert.deepEqual(findBaseUrlDependencies(spec), []);

  const withExamples = {
    openapi: '3.1.0',
    info,
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/a': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    examples: [{ $ref: './data.json' }],
                    properties: { example: { $ref: './real.yaml#/X' } }
                  },
                  example: { $ref: './sample.json' },
                  examples: { one: { value: { $ref: './other.json' } } }
                }
              }
            }
          }
        }
      }
    }
  };
  assert.deepEqual(findBaseUrlDependencies(withExamples), [
    'Relative external $ref "./real.yaml#/X" (cannot be loaded from the preview).'
  ]);
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
    Text with </SCRIPT> and two lines
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
  assert.throws(() => parseOpenApiDocument('   '), /empty/);
});

test('Swagger preview sends Try it out requests through the extension host (no CORS)', () => {
  const html = buildSwaggerUiHtml(
    { cspSource: 'vscode-resource:', asWebviewUri: (u) => String(u) },
    { extensionUri: { path: '/ext', with() {} } },
    { openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} }
  );
  const config = readSwaggerConfig(html);
  const req = config.requestInterceptor({ url: 'http://localhost:5080/a' });
  assert.equal(typeof req.userFetch, 'function');
});

const PROXY_SPEC = { openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} };

function previewHtml() {
  return buildSwaggerUiHtml(
    { cspSource: 'vscode-resource:', asWebviewUri: (u) => String(u) },
    { extensionUri: { path: '/ext', with() {} } },
    PROXY_SPEC
  );
}

test('Swagger preview scripts run with a nonce, not unsafe-inline', () => {
  const html = previewHtml();
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  const scriptSrc = /script-src ([^;]*);/.exec(csp)[1];
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
  const nonce = /'nonce-([^']+)'/.exec(scriptSrc)[1];
  const scripts = html.match(/<script\b[^>]*>/g);
  assert.ok(scripts.length >= 2);
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  assert.notEqual(/'nonce-([^']+)'/.exec(previewHtml())[1], nonce, 'a fresh nonce per render');
});

async function proxyCall(result) {
  const config = readSwaggerConfig(previewHtml());
  const { listeners, posted } = config.__webview;
  const req = config.requestInterceptor({ url: 'http://api.test/a' });
  const promise = req.userFetch('http://api.test/a', { method: 'GET' });
  await new Promise((r) => setImmediate(r));
  assert.equal(posted.length, 1);
  listeners.message({ data: { type: 'wrenchit.fetchResult', id: posted[0].id, ...result } });
  return promise;
}

test('Try it out rejects (does not hang) when the status cannot be a Response', async () => {
  for (const status of [101, 103, 600]) {
    await assert.rejects(proxyCall({ ok: true, status, statusText: '', headers: [], body: '' }), /HTTP \d+/);
  }
  const res = await proxyCall({ ok: true, status: 201, statusText: 'Created', headers: [['x-a', '1']], body: Buffer.from('hi').toString('base64') });
  assert.equal(res.status, 201);
  assert.equal(await res.text(), 'hi');
  await assert.rejects(proxyCall({ ok: false, error: 'boom' }), /boom/);
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

const allowAll = () => true;
const proxyRequest = (over) => ({ type: 'wrenchit.fetch', id: 1, url: 'http://api.test/x', method: 'GET', headers: {}, ...over });

test('proxy rejects protocols other than http and https', async () => {
  const fetch = fakeFetch(() => new Response('no'));
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi']) {
    const reply = await runProxyRequest(proxyRequest({ url }), { fetch, isHostAllowed: allowAll });
    assert.equal(reply.ok, false, url);
    assert.match(reply.error, /Unsupported protocol/);
  }
  assert.equal(fetch.calls.length, 0);
});

test('proxy passes status, headers and body, and drops wire-format headers', async () => {
  const fetch = fakeFetch(() => new Response('{"a":1}', {
    status: 418,
    statusText: 'Teapot',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '7', 'x-trace': 'abc' }
  }));
  const reply = await runProxyRequest(
    proxyRequest({ method: 'post', headers: { authorization: 'Bearer t' }, body: Buffer.from('payload').toString('base64') }),
    { fetch, isHostAllowed: allowAll }
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 418);
  assert.equal(reply.statusText, 'Teapot');
  const headers = Object.fromEntries(reply.headers);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-trace'], 'abc');
  assert.equal('content-encoding' in headers, false);
  assert.equal('content-length' in headers, false);
  assert.equal(Buffer.from(reply.body, 'base64').toString(), '{"a":1}');
  const [call] = fetch.calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, 'Bearer t');
  assert.equal(Buffer.from(call.init.body).toString(), 'payload');
  assert.ok(call.init.signal, 'the request can be cancelled');
});

test('proxy turns network errors into ok:false with the cause', async () => {
  const fetch = fakeFetch(() => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') }); });
  const reply = await runProxyRequest(proxyRequest(), { fetch, isHostAllowed: allowAll });
  assert.deepEqual(reply, { ok: false, error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:1' });
});

function hangingFetch() {
  return fakeFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
}

test('proxy cancels a request that takes too long, or when the preview closes', async () => {
  const timedOut = await runProxyRequest(proxyRequest(), { fetch: hangingFetch(), isHostAllowed: allowAll, timeoutMs: 20 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /No response after/);

  const lifetime = new AbortController();
  const pending = runProxyRequest(proxyRequest(), { fetch: hangingFetch(), isHostAllowed: allowAll, signal: lifetime.signal });
  lifetime.abort();
  const closed = await pending;
  assert.equal(closed.ok, false);
  assert.match(closed.error, /preview was closed/);
});

test('proxy refuses bodies above the size limit in both directions', async () => {
  const big = fakeFetch(() => new Response('x'.repeat(2048)));
  const down = await runProxyRequest(proxyRequest(), { fetch: big, isHostAllowed: allowAll, maxBytes: 1024 });
  assert.equal(down.ok, false);
  assert.match(down.error, /response is larger than/);

  const declared = fakeFetch(() => new Response('x', { headers: { 'content-length': '999999' } }));
  const early = await runProxyRequest(proxyRequest(), { fetch: declared, isHostAllowed: allowAll, maxBytes: 1024 });
  assert.match(early.error, /response is larger than/);

  const ok = fakeFetch(() => new Response('fine'));
  const up = await runProxyRequest(
    proxyRequest({ method: 'POST', body: Buffer.alloc(4096).toString('base64') }),
    { fetch: ok, isHostAllowed: allowAll, maxBytes: 1024 }
  );
  assert.match(up.error, /request body is larger than/);
  assert.equal(ok.calls.length, 0);
});

test('proxy only calls hosts the host check allows', async () => {
  const fetch = fakeFetch(() => new Response('ok'));
  const asked = [];
  const reply = await runProxyRequest(proxyRequest({ url: 'http://127.0.0.1:8080/admin' }), {
    fetch,
    isHostAllowed: (url) => { asked.push(url.host); return false; }
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /127\.0\.0\.1:8080 are not allowed/);
  assert.deepEqual(asked, ['127.0.0.1:8080']);
  assert.equal(fetch.calls.length, 0);
});

test('collectSpecHosts lists the absolute servers the spec declares', () => {
  const hosts = collectSpecHosts({
    openapi: '3.0.3',
    servers: [
      { url: 'https://API.example.com/v1' },
      { url: '/relative' },
      { url: 'https://{env}.example.com:{port}', variables: { env: { default: 'prod', enum: ['prod', 'staging'] }, port: { default: '8443' } } },
      { url: 'https://{unknown}.example.com' }
    ],
    paths: {
      '/a': { servers: [{ url: 'http://localhost:5080' }], get: { servers: [{ url: '//cdn.example.com' }] } }
    }
  });
  assert.deepEqual([...hosts].sort(), [
    'api.example.com', 'cdn.example.com', 'localhost:5080', 'prod.example.com:8443', 'staging.example.com:8443'
  ]);
  assert.deepEqual([...collectSpecHosts({ swagger: '2.0', host: 'petstore.example.com:8080' })], ['petstore.example.com:8080']);
  assert.deepEqual([...collectSpecHosts({ swagger: '2.0' })], []);
});

test('describeError adds the cause only when it says something new', () => {
  assert.equal(describeError(new Error('plain')), 'plain');
  assert.equal(describeError(new Error('fetch failed', { cause: new Error('ENOTFOUND x') })), 'fetch failed: ENOTFOUND x');
  assert.equal(describeError(new Error('same', { cause: 'same' })), 'same');
  assert.equal(describeError('text'), 'text');
});
