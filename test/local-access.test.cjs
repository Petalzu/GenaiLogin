const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');

const pngImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmf0AAAAASUVORK5CYII=', 'base64');

function connectionHarness(options = {}) {
    const commands = new Map();
    const messages = [];
    const subscriptions = [];
    const timers = [];
    const loginCalls = [];
    const servers = [];
    let provider;
    let mcpProvider, configurationChanged;
    let mcpEnabled = options.mcpEnabled || false;
    const updates = [], notices = [];
    const loaded = [], traces = [];
    const saved = new Map(options.credentials === false ? [] : [['credentials', '{"username":"test","password":"dummy"}']]);
    const disposable = { dispose() {} };
    const fakeVscode = {
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => key === 'idleTimeoutSeconds' ? options.idleSeconds || 0 : key === 'port' ? options.port || fallback : key === 'imageMcp.enabled' ? mcpEnabled : fallback,
                update: async (...args) => {
                    updates.push(args); mcpEnabled = args[1];
                    configurationChanged?.({ affectsConfiguration: name => name === 'genai-login.imageMcp.enabled' });
                }
            }),
            onDidChangeConfiguration: callback => { configurationChanged = callback; return disposable; }
        },
        ConfigurationTarget: { Global: 1 },
        window: {
            createOutputChannel: () => ({ ...disposable, appendLine: message => traces.push(message), show() {} }),
            registerWebviewViewProvider: (name, value) => { provider = value; return disposable; },
            showInformationMessage: async message => { notices.push(message); }, showErrorMessage: async () => {},
            showWarningMessage: options.confirm || (async () => undefined),
            showInputBox: options.input || (() => assert.fail('unexpected credential input'))
        },
        commands: { registerCommand: (name, action) => { commands.set(name, action); return disposable; } }
    };
    if (options.mcpApi) {
        Object.assign(fakeVscode, {
            lm: { registerMcpServerDefinitionProvider: (id, value) => { assert.equal(id, 'genai-login.drawing'); mcpProvider = value; return disposable; } },
            EventEmitter: function () {
                const callbacks = [];
                this.event = callback => { callbacks.push(callback); return disposable; };
                this.fire = () => { for (const callback of callbacks) callback(); };
                this.dispose = () => {};
            },
            Uri: { parse: value => value },
            McpHttpServerDefinition: function (label, uri, headers, version) { Object.assign(this, { label, uri, headers, version }); }
        });
    }
    if (options.directory) {
        const { promises } = fs;
        const uri = path => ({ path, fsPath: path });
        fakeVscode.Uri = { ...fakeVscode.Uri, joinPath: (base, ...parts) => uri(require('node:path').join(base.fsPath, ...parts)) };
        fakeVscode.workspace.fs = {
            createDirectory: target => promises.mkdir(target.fsPath, { recursive: true }),
            readDirectory: async target => (await promises.readdir(target.fsPath)).map(name => [name, 1]),
            readFile: target => promises.readFile(target.fsPath),
            writeFile: (target, bytes) => promises.writeFile(target.fsPath, bytes),
            rename: (source, destination) => promises.rename(source.fsPath, destination.fsPath)
        };
    }
    const fakeHttp = { createServer: handler => {
        const server = Object.assign(new EventEmitter(), { handle: handler,
            listen: (port, host, ready) => { server.port = port; server.host = host; queueMicrotask(() => { server.listening = true; ready(); }); },
            closeAllConnections() {}, close() { server.listening = false; } });
        servers.push(server); return server;
    } };
    class Session {
        constructor() { this.jar = { toJSON: () => ({ cookies: [{ key: 'token', value: 'dummy' }] }), setCookie: async () => {} }; }
        valid(signal, fetch) { return options.valid ? options.valid(signal, fetch) : Promise.resolve(true); }
        request(url, settings) { return options.request ? options.request(url, settings) : Promise.resolve(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })); }
    }
    const secrets = {
        get: options.get || (async key => saved.get(key)),
        store: options.store || (async (key, value) => { saved.set(key, value); }),
        delete: options.delete || (async key => { saved.delete(key); })
    };
    const sandbox = {
        module: { exports: {} }, AbortController, AbortSignal, Buffer, URL,
        Date: options.now ? class extends Date { static now() { return options.now(); } } : Date,
        setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds, unref() {} }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cancelled = true; }, setInterval: () => ({ unref() {} }), clearInterval() {},
        fetch: async () => { throw new Error('no other owner'); },
        require: name => {
            loaded.push(name);
            if (name === 'vscode') return fakeVscode;
            if (name === 'node:http') return options.realHttp ? require('node:http') : fakeHttp;
            if (name === './upstream') return { Agent: class { destroy() { return Promise.resolve(); } }, fetch() { assert.fail('unexpected network'); } };
            if (name === './auth') return { ...require('../auth'), Session };
            if (name === './browser-auth') return { browserLogin: async (...args) => { loginCalls.push(args); return options.login?.(...args); } };
            return require(name.startsWith('./') ? '../' + name.slice(2) : name);
        }
    };
    vm.runInNewContext(fs.readFileSync(process.env.GENAI_EXTENSION_MODULE || require.resolve('../extension.js'), 'utf8'), sandbox);
    const ready = sandbox.module.exports.activate({ subscriptions, secrets, globalState: options.globalState || { get() {}, keys: () => [], update: async () => {} },
        globalStorageUri: options.directory ? { path: options.directory, fsPath: options.directory } : undefined });
    if (!options.deferDashboard) provider.resolveWebviewView({ visible: false, webview: { postMessage: message => messages.push(message.data), onDidReceiveMessage: () => disposable },
        onDidChangeVisibility: () => disposable, onDidDispose: () => disposable });
    return { loginCalls, timers, servers, messages, secrets, loaded, ready, commands, mcpProvider, updates, notices, traces,
        action: name => commands.get(`genai-login.${name}`)(),
        snapshot: () => provider.getState(),
        dispose: () => { for (const item of subscriptions) item.dispose(); }
    };
}

function chatExchange(url = '/v1/chat/completions', body = '{"model":"test","stream":true}') {
    const chunks = [];
    const response = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.writeHead = (status, headers) => { response.status = status; response.headers = headers; response.headersSent = true; };
    const request = { method: 'POST', url, headers: { host: '127.0.0.1:58379', authorization: 'Bearer local-browser-session' },
        destroy() { this.destroyed = true; }, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } };
    return { request, response, chunks };
}

test('activation listens only on loopback without reading credentials or loading authentication', async () => {
    const harness = connectionHarness({ get: () => assert.fail('startup must not read secrets') });
    try {
        await harness.ready;
        assert.equal(harness.servers.length, 1);
        assert.equal(harness.servers[0].host, '127.0.0.1');
        assert.equal(harness.servers[0].port, 58379);
        assert.equal(harness.snapshot().listening, true);
        assert.equal(harness.snapshot().active, false);
        assert.equal(harness.snapshot().connectedAt, null);
        assert.equal(harness.loginCalls.length, 0);
        assert.equal(harness.timers.length, 0);
        for (const name of ['undici', './upstream', './auth', './browser-auth', './image-mcp']) assert.ok(!harness.loaded.includes(name));
    } finally { harness.dispose(); }
});

test('activation without a dashboard does not initialize or read usage history', async () => {
    const harness = connectionHarness({ deferDashboard: true, globalState: {
        get: () => assert.fail('idle activation must not read history'),
        keys: () => assert.fail('idle activation must not enumerate history'),
        update: () => assert.fail('idle activation must not write history')
    } });
    try {
        await harness.ready;
        assert.equal(harness.servers[0].listening, true);
        assert.equal(harness.loaded.includes('node:crypto'), false);
    } finally { harness.dispose(); }
});

test('drawing MCP setup is available from the dashboard and command palette', async () => {
    const harness = connectionHarness({ get: () => assert.fail('setup must not read secrets') });
    try {
        await harness.ready;
        assert.equal(typeof harness.commands.get('genai-login.mcp'), 'function');
        assert.match(require('../dashboard').dashboardHtml(), /data-command="mcp"/);
        assert.equal(harness.loginCalls.length, 0);
    } finally { harness.dispose(); }
});

test('one click enables the native drawing MCP once without login or user MCP file edits', async () => {
    for (const port of [58379, 58480]) {
        const harness = connectionHarness({ port, mcpApi: true, get: () => assert.fail('setup must not read secrets') });
        try {
            await harness.ready;
            let changes = 0;
            harness.mcpProvider.onDidChangeMcpServerDefinitions(() => { changes++; });
            assert.equal(harness.mcpProvider.provideMcpServerDefinitions().length, 0);
            await harness.action('mcp');
            await harness.action('mcp');
            assert.deepEqual(harness.updates, [['imageMcp.enabled', true, 1]]);
            assert.equal(changes, 1);
            const definitions = harness.mcpProvider.provideMcpServerDefinitions();
            assert.equal(definitions.length, 1);
            assert.equal(definitions[0].label, 'GENAI / Qwen Image 2.1');
            assert.equal(definitions[0].uri, `http://127.0.0.1:${port}/mcp`);
            assert.equal(definitions[0].headers.Authorization, 'Bearer local-browser-session');
            assert.equal(harness.loginCalls.length, 0);
            assert.ok(!harness.loaded.includes('./image-mcp'));
        } finally { harness.dispose(); }
    }
});

test('status queries, unknown routes and rejected requests never start authentication', async () => {
    const harness = connectionHarness({ get: () => assert.fail('non-API request must not read secrets') });
    try {
        await harness.ready;
        for (const scenario of [
            { url: '/internal/status', method: 'GET', status: 200 },
            { url: '/mcp', status: 404 },
            { url: '/mcp', headers: { authorization: 'wrong' }, status: 403 },
            { url: '/mcp', headers: { origin: 'https://evil.example' }, status: 403 },
            { url: '/mcp', headers: { 'sec-fetch-site': 'cross-site' }, status: 403 },
            { url: '/not-found', status: 404 },
            { url: '/v1/chat/completions', headers: { authorization: 'wrong' }, status: 403 },
            { url: '/v1/images/generations', headers: { origin: 'https://evil.example' }, status: 403 },
            { url: '/v1/models', method: 'GET', headers: { host: 'evil.example' }, status: 403 },
            { url: '/v1/images/generations', headers: { 'sec-fetch-site': 'cross-site' }, status: 403 }
        ]) {
            const exchange = chatExchange(scenario.url);
            if (scenario.method) exchange.request.method = scenario.method;
            Object.assign(exchange.request.headers, scenario.headers);
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response);
            await finished;
            assert.equal(exchange.response.status, scenario.status);
            if (scenario.status === 200) {
                const state = JSON.parse(Buffer.concat(exchange.chunks).toString()).state;
                assert.equal(state.listening, true);
                assert.equal(state.active, false);
            }
        }
        assert.equal(harness.loginCalls.length, 0);
    } finally { harness.dispose(); }
});

test('first Copilot chat request connects automatically without the connect command', async () => {
    const harness = connectionHarness();
    try {
        await harness.ready;
        for (let attempt = 0; attempt < 2; attempt++) {
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response);
            await finished; await nextTurn();
            assert.equal(exchange.response.status, 200);
            assert.equal(Buffer.concat(exchange.chunks).toString(), 'data: [DONE]\n\n');
        }
        assert.equal(harness.loginCalls.length, 1);
        assert.equal(harness.loginCalls[0][5], false);
        assert.equal(harness.loginCalls[0][6], true);
        assert.equal(harness.loginCalls[0][7].force, true);
        assert.equal(harness.snapshot().requests, 2);
        assert.equal(harness.snapshot().connection, 'connected');
        assert.equal(harness.servers.length, 1);
    } finally { harness.dispose(); }
});

test('first MCP image request connects automatically and returns inline image bytes', async () => {
    const harness = connectionHarness({ request: async url => url.endsWith('/api/v1/images/generations')
        ? Response.json([{ url: '/api/v1/files/file-1/content' }]) : new Response(pngImage) });
    try {
        await harness.ready;
        const exchange = chatExchange('/v1/images/generations', '{"model":"qwen-image-2.1","prompt":"a red apple"}');
        const finished = new Promise(resolve => exchange.response.once('finish', resolve));
        harness.servers[0].handle(exchange.request, exchange.response);
        await finished;
        assert.equal(exchange.response.status, 200);
        assert.deepEqual(Buffer.from(JSON.parse(Buffer.concat(exchange.chunks).toString()).data[0].b64_json, 'base64'), pngImage);
        assert.equal(harness.loginCalls.length, 1);
    } finally { harness.dispose(); }
});

test('model discovery can initialize a connection without a chat request', async () => {
    const harness = connectionHarness({ request: async url => {
        assert.equal(url, 'https://chat.genai.um.edu.mo/api/v1/models');
        return Response.json({ data: [{ id: 'test-model' }] });
    } });
    try {
        await harness.ready;
        const exchange = chatExchange('/v1/models');
        exchange.request.method = 'GET';
        const finished = new Promise(resolve => exchange.response.once('finish', resolve));
        harness.servers[0].handle(exchange.request, exchange.response);
        await finished;
        assert.equal(exchange.response.status, 200);
        assert.equal(JSON.parse(Buffer.concat(exchange.chunks).toString()).data[0].id, 'test-model');
        assert.equal(harness.loginCalls.length, 1);
        assert.equal(harness.snapshot().requests, 0);
    } finally { harness.dispose(); }
});

test('concurrent initial API requests share one login while a cancelled caller is released', async () => {
    let finishLogin, forwarded = 0;
    const harness = connectionHarness({ login: () => new Promise(resolve => { finishLogin = resolve; }), request: async () => {
        forwarded++;
        return Response.json({ choices: [] });
    } });
    try {
        await harness.ready;
        const cancelled = chatExchange();
        const remaining = chatExchange();
        const finished = new Promise(resolve => remaining.response.once('finish', resolve));
        harness.servers[0].handle(cancelled.request, cancelled.response);
        harness.servers[0].handle(remaining.request, remaining.response);
        await nextTurn();
        assert.equal(harness.loginCalls.length, 1);
        assert.equal(forwarded, 0);
        cancelled.response.destroy(); await nextTurn();
        assert.equal(cancelled.request.destroyed, true);
        assert.equal(cancelled.response.listenerCount('close'), 0);
        assert.equal(harness.loginCalls[0][2].aborted, false);
        finishLogin();
        await finished;
        assert.equal(remaining.response.status, 200);
        assert.equal(forwarded, 1);
        assert.equal(harness.snapshot().connection, 'connected');
    } finally { finishLogin?.(); harness.dispose(); }
});

test('first request can save missing credentials and cancelled input leaves the listener idle', async () => {
    for (const cancelled of [false, true]) {
        const inputs = [];
        const harness = connectionHarness({ credentials: false, input: async options => {
            inputs.push(options);
            if (cancelled) return undefined;
            return options.password ? 'dummy' : 'test';
        } });
        try {
            await harness.ready;
            assert.equal(inputs.length, 0);
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response);
            await finished;
            assert.equal(exchange.response.status, cancelled ? 503 : 200);
            assert.equal(inputs.length, cancelled ? 1 : 2);
            if (!cancelled) assert.equal(inputs[1].password, true);
            assert.equal(harness.loginCalls.length, cancelled ? 0 : 1);
            assert.equal(harness.snapshot().listening, true);
        } finally { harness.dispose(); }
    }
});

test('initial connection failure retains the listener and a later request can retry', async () => {
    let attempts = 0;
    const harness = connectionHarness({ login: async () => {
        if (++attempts === 1) throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE' });
    } });
    try {
        await harness.ready;
        for (const status of [503, 200]) {
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response);
            await finished;
            assert.equal(exchange.response.status, status);
            assert.equal(harness.snapshot().listening, true);
        }
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.servers.length, 1);
    } finally { harness.dispose(); }
});

test('automatic and manual connections use identical headless login settings', async () => {
    const settings = [];
    for (const automatic of [false, true]) {
        const harness = connectionHarness();
        try {
            await harness.ready;
            if (automatic) {
                const exchange = chatExchange();
                const finished = new Promise(resolve => exchange.response.once('finish', resolve));
                harness.servers[0].handle(exchange.request, exchange.response); await finished;
                assert.equal(exchange.response.status, 200);
            } else await harness.action('connect');
            const call = harness.loginCalls[0];
            assert.equal(call[5], false);
            assert.equal(call[6], true);
            assert.equal(call[7].force, true);
            settings.push(JSON.parse(JSON.stringify(call.slice(5))));
        } finally { harness.dispose(); }
    }
    assert.deepEqual(settings[0], settings[1]);
});

test('initial automatic connection starts headless Edge before checking the session and forwards the original prompt', async () => {
    const { browserLogin } = require(process.env.GENAI_BROWSER_MODULE || '../browser-auth');
    for (const path of ['/', '/oauth/oidc/callback']) {
        let checks = 0, forwarded = 0, launches = 0, closed = 0;
        const page = { on() {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo' + path, locator: () => ({}) };
        const harness = connectionHarness({ valid: async (signal, fetch) => {
            assert.equal(launches, 1, 'Node prechecks must not block browser login');
            assert.equal(typeof fetch, 'function');
            checks++;
            return true;
        }, login: (session, credentials, signal, trace, launcher, keepOpen, headless, settings) =>
            browserLogin(session, credentials, signal, trace, { launch: async options => {
                launches++;
                assert.equal(options.headless, true);
                return { close: async () => { closed++; }, newContext: async () => ({ newPage: async () => page,
                    cookies: async () => [{ name: 'token', value: 'fresh', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
            } }, keepOpen, headless, settings),
        request: async () => { forwarded++; return Response.json({ choices: [] }); } });
        try {
            await harness.ready;
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response); await finished;
            assert.equal(exchange.response.status, 200);
            assert.equal(harness.snapshot().listening, true);
            assert.equal(checks, 1);
            assert.equal(harness.loginCalls.length, 1);
            assert.equal(launches, 1);
            assert.equal(closed, launches);
            assert.equal(harness.servers.length, 1);
            assert.equal(harness.snapshot().connection, 'connected');
            assert.equal(forwarded, 1);
        } finally { harness.dispose(); }
    }
});

test('initial automatic failures cool down across requests and retry after the deadline', async () => {
    for (const failure of [{ cause: { code: 'ECONNRESET' } }, { code: 'SESSION_CHECK_TIMEOUT' },
        { code: 'SESSION_UNAVAILABLE', status: 503 }, { code: 'SESSION_UNAVAILABLE', status: 429, retryAfterMs: 90000 }]) {
        let now = Date.now();
        const harness = connectionHarness({ now: () => now, login: async () => {
            if (harness.loginCalls.length === 1) throw Object.assign(new Error('temporarily unavailable'), failure);
        } });
        try {
            await harness.ready;
            const retrySeconds = failure.retryAfterMs ? failure.retryAfterMs / 1000 : 30;
            for (let attempt = 0; attempt < 3; attempt++) {
                const exchange = chatExchange();
                const finished = new Promise(resolve => exchange.response.once('finish', resolve));
                harness.servers[0].handle(exchange.request, exchange.response); await finished;
                assert.equal(exchange.response.status, 503);
                assert.equal(exchange.response.headers['retry-after'], String(retrySeconds));
                assert.equal(harness.loginCalls.length, 1);
                assert.equal(harness.snapshot().active, false);
                assert.equal(harness.snapshot().keepalive.nextCheckAt, now + retrySeconds * 1000);
            }
            now += retrySeconds * 1000;
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response); await finished;
            assert.equal(exchange.response.status, 200);
            assert.equal(harness.loginCalls.length, 2);
            assert.equal(harness.servers.length, 1);
            assert.equal(harness.snapshot().connection, 'connected');
            assert.equal(harness.traces.filter(message => message.includes('Connection failed:')).length, 1);
        } finally { harness.dispose(); }
    }
});

test('initial automatic connection cooldown grows to five minutes without background MFA', async () => {
    let now = Date.now();
    const harness = connectionHarness({ now: () => now, login: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    } });
    try {
        await harness.ready;
        for (const seconds of [30, 60, 120, 240, 300, 300]) {
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response); await finished;
            assert.equal(exchange.response.status, 503);
            assert.equal(exchange.response.headers['retry-after'], String(seconds));
            now += seconds * 1000;
        }
        assert.equal(harness.loginCalls.length, 6);
        assert.ok(harness.timers.every(timer => timer.cancelled));
    } finally { harness.dispose(); }
});

test('explicit Connect can recover during the initial transport cooldown', async () => {
    const harness = connectionHarness({ login: async () => {
        if (harness.loginCalls.length === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    } });
    try {
        await harness.ready;
        const exchange = chatExchange();
        const finished = new Promise(resolve => exchange.response.once('finish', resolve));
        harness.servers[0].handle(exchange.request, exchange.response); await finished;
        assert.equal(exchange.response.status, 503);
        await harness.action('connect');
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.loginCalls[1][7].force, true);
        assert.equal(harness.snapshot().connection, 'connected');
    } finally { harness.dispose(); }
});

test('concurrent callers share headless verification and a cancelled request is never forwarded', async () => {
    const { browserLogin } = require(process.env.GENAI_BROWSER_MODULE || '../browser-auth');
    let checks = 0, forwarded = 0, checkStarted, verify;
    const checking = new Promise(resolve => { checkStarted = resolve; });
    const verified = new Promise(resolve => { verify = resolve; });
    const page = { on() {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const harness = connectionHarness({ valid: async () => {
        checks++;
        checkStarted();
        await verified;
        return true;
    }, login: (session, credentials, signal, trace, launcher, keepOpen, headless, settings) =>
        browserLogin(session, credentials, signal, trace, { launch: async () => ({ close: async () => {},
            newContext: async () => ({ newPage: async () => page,
                cookies: async () => [{ name: 'token', value: 'fresh', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) }) }, keepOpen, headless, settings),
    request: async () => { forwarded++; return Response.json({ choices: [] }); } });
    try {
        await harness.ready;
        const cancelled = chatExchange(), remaining = chatExchange();
        const finished = new Promise(resolve => remaining.response.once('finish', resolve));
        harness.servers[0].handle(cancelled.request, cancelled.response);
        harness.servers[0].handle(remaining.request, remaining.response);
        await checking;
        cancelled.response.destroy(); await nextTurn();
        assert.equal(harness.loginCalls[0][2].aborted, false);
        verify();
        await finished;
        assert.equal(remaining.response.status, 200);
        assert.equal(harness.loginCalls.length, 1);
        assert.equal(checks, 1);
        assert.equal(forwarded, 1);
        assert.equal(cancelled.request.destroyed, true);
    } finally { verify(); harness.dispose(); }
});

test('initial verification failure blocks repeated MFA until an explicit connection attempt', async () => {
    for (const failure of [{ name: 'TimeoutError' }, { code: 'CREDENTIALS_REJECTED' },
        { code: 'SESSION_CHECK_TIMEOUT', retryAuthentication: false },
        { code: 'SESSION_UNAVAILABLE', status: 503, retryAuthentication: false }]) {
        let attempts = 0;
        const harness = connectionHarness({ login: async () => {
            if (++attempts === 1) throw Object.assign(new Error('verification incomplete'), failure);
        } });
        try {
            await harness.ready;
            for (const status of [503, 401, 401]) {
                const exchange = chatExchange();
                const finished = new Promise(resolve => exchange.response.once('finish', resolve));
                harness.servers[0].handle(exchange.request, exchange.response);
                await finished;
                assert.equal(exchange.response.status, status);
            }
            assert.equal(harness.loginCalls.length, 1);
            assert.equal(harness.snapshot().keepalive.state, 'needs-login');
            assert.equal(harness.snapshot().listening, true);
            await harness.action('connect');
            assert.equal(harness.loginCalls.length, 2);
            assert.equal(harness.loginCalls[1][7].force, true);
            assert.equal(harness.snapshot().connection, 'connected');
        } finally { harness.dispose(); }
    }
});

test('disconnect cancels the pending initial headless verification without reconnecting later', async () => {
    const { browserLogin } = require(process.env.GENAI_BROWSER_MODULE || '../browser-auth');
    let checks = 0, checkStarted, finishedLogin, closed = 0;
    const checking = new Promise(resolve => { checkStarted = resolve; });
    const finished = new Promise(resolve => { finishedLogin = resolve; });
    const page = { on() {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const harness = connectionHarness({ valid: async signal => {
        checks++;
        checkStarted();
        return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
    }, login: (session, credentials, signal, trace, launcher, keepOpen, headless, settings) =>
        browserLogin(session, credentials, signal, trace, { launch: async () => ({ close: async () => { closed++; },
            newContext: async () => ({ newPage: async () => page,
                cookies: async () => [{ name: 'token', value: 'fresh', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) }) }, keepOpen, headless, settings).finally(finishedLogin),
    request: () => assert.fail('cancelled request must not be forwarded') });
    try {
        await harness.ready;
        const exchange = chatExchange();
        harness.servers[0].handle(exchange.request, exchange.response);
        await checking;
        await harness.action('disconnect');
        await finished; await nextTurn();
        assert.equal(checks, 1);
        assert.equal(closed, 1);
        assert.equal(harness.loginCalls[0][2].aborted, true);
        assert.equal(harness.snapshot().active, false);
        assert.equal(harness.snapshot().listening, false);
        assert.equal(harness.snapshot().connection, 'disconnected');
    } finally { harness.dispose(); }
});

test('disposal during listener startup cannot leave a listening server behind', async () => {
    const harness = connectionHarness();
    harness.dispose();
    await harness.ready;
    assert.equal(harness.snapshot().listening, false);
    assert.equal(harness.servers[0].listening, false);
    assert.equal(harness.loginCalls.length, 0);
});

test('disconnect while credentials are loading prevents a late automatic login', async () => {
    let release;
    const harness = connectionHarness({ get: () => new Promise(resolve => { release = resolve; }) });
    try {
        await harness.ready;
        const exchange = chatExchange();
        harness.servers[0].handle(exchange.request, exchange.response);
        await nextTurn();
        await harness.action('disconnect');
        release('{"username":"test","password":"dummy"}');
        await nextTurn();
        assert.equal(harness.loginCalls.length, 0);
        assert.equal(harness.snapshot().active, false);
        assert.equal(harness.snapshot().listening, false);
        assert.equal(exchange.request.destroyed, true);
        assert.equal(exchange.response.listenerCount('close'), 0);
    } finally { harness.dispose(); }
});

test('real loopback HTTP requests initialize once and forward both chat and image responses', { timeout: 10000 }, async () => {
    const probe = require('node:http').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const harness = connectionHarness({ realHttp: true, port, request: async url => {
        if (url.endsWith('/api/v1/images/generations')) return Response.json([{ url: '/api/v1/files/file-1/content' }]);
        if (url.endsWith('/api/v1/files/file-1/content')) return new Response(pngImage);
        return Response.json({ choices: [{ message: { content: 'connected on demand' } }] });
    } });
    try {
        await harness.ready;
        const headers = { Authorization: 'Bearer local-browser-session', 'Content-Type': 'application/json' };
        const base = `http://127.0.0.1:${port}`;
        const state = await fetch(base + '/internal/status', { headers });
        assert.equal((await state.json()).state.active, false);
        const denied = await fetch(base + '/v1/chat/completions', { method: 'POST', body: '{}', headers: { Authorization: 'wrong' } });
        assert.equal(denied.status, 403);
        await denied.arrayBuffer();
        assert.equal(harness.loginCalls.length, 0);
        const chat = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: '{"model":"test","messages":[]}' });
        assert.equal(chat.status, 200);
        assert.equal((await chat.json()).choices[0].message.content, 'connected on demand');
        const image = await fetch(base + '/v1/images/generations', { method: 'POST', headers, body: '{"prompt":"a red apple"}' });
        assert.equal(image.status, 200);
        assert.deepEqual(Buffer.from((await image.json()).data[0].b64_json, 'base64'), pngImage);
        assert.equal(harness.loginCalls.length, 1);
    } finally { harness.dispose(); }
});

test('native MCP discovery stays idle and the first drawing tool call logs in through the real bridge', { timeout: 10000 }, async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const directory = await fs.promises.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'genai-drawing-bridge-'));
    const probe = require('node:http').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const requests = [];
    const harness = connectionHarness({ directory, port, realHttp: true, mcpEnabled: true, request: async (url, settings) => {
        requests.push({ url, settings });
        if (url.endsWith('/api/v1/images/generations')) return Response.json([{ url: '/api/v1/files/image-1/content' }]);
        if (url.endsWith('/api/v1/files/image-1/content')) return new Response(pngImage);
        assert.fail('unexpected platform route');
    } });
    const client = new Client({ name: 'native-genai-test', version: '1.0.0' });
    try {
        await harness.ready;
        const url = new URL(`http://127.0.0.1:${port}/mcp`);
        const headers = { Authorization: 'Bearer local-browser-session' };
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['generate_image']);
        assert.equal(harness.loginCalls.length, 0);
        assert.equal(harness.loaded.includes('./auth'), false);
        const denied = await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' });
        assert.equal(denied.status, 403);
        await denied.arrayBuffer();
        const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a red apple' } });
        assert.ok(!result.isError);
        assert.equal(harness.loginCalls.length, 1);
        assert.equal(harness.snapshot().requests, 1);
        assert.equal(requests.length, 2);
        assert.equal(JSON.parse(requests[0].settings.body).model, 'qwen-image-2.1');
        assert.deepEqual(await fs.promises.readFile(result.structuredContent.files[0]), pngImage);
        assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), pngImage);
    } finally {
        await client.close();
        harness.dispose();
        await nextTurn();
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
});

test('explicit disconnect closes the idle listener and manual connect can restart it', async () => {
    const harness = connectionHarness();
    try {
        await harness.ready;
        await harness.action('disconnect');
        assert.equal(harness.snapshot().listening, false);
        assert.equal(harness.servers[0].listening, false);
        assert.equal(harness.loginCalls.length, 0);
        await harness.action('connect');
        assert.equal(harness.snapshot().listening, true);
        assert.equal(harness.snapshot().connection, 'connected');
        assert.equal(harness.servers.length, 2);
    } finally { harness.dispose(); }
});

test('slow or failed session storage does not block successful upstream forwarding', { timeout: 3000 }, async () => {
    for (const failure of [false, true]) {
        let release;
        const harness = connectionHarness({ store: async () => {
            if (failure) throw new Error('storage unavailable');
            await new Promise(resolve => { release = resolve; });
        } });
        try {
            await harness.action('connect');
            const { request, response, chunks } = chatExchange();
            const finished = new Promise((resolve, reject) => { response.once('finish', resolve); response.once('error', reject); });
            harness.servers.at(-1).handle(request, response);
            await finished; await nextTurn();
            assert.equal(response.status, 200);
            assert.equal(Buffer.concat(chunks).toString(), 'data: [DONE]\n\n');
            assert.match(harness.snapshot().status, /^Connected/);
            if (failure) assert.equal(harness.snapshot().sessionPersistence, 'error');
        } finally { release?.(); harness.dispose(); }
    }
});

test('image generation responses convert platform files into inline OpenAI image data', async () => {
    const requested = [];
    const harness = connectionHarness({ request: async url => {
        requested.push(url);
        if (url.endsWith('/api/v1/images/generations')) {
            return new Response(JSON.stringify([{ id: 'file-1', url: '/api/v1/files/file-1/content', name: 'generated-image.png', content_type: 'image/png' }]),
                { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(pngImage, { status: 200, headers: { 'content-type': 'image/png' } });
    } });
    try {
        await harness.action('connect');
        const { request, response, chunks } = chatExchange('/v1/images/generations', '{"model":"Qwen-Image-2.1","prompt":"a red apple"}');
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response);
        await finished;
        assert.equal(response.status, 200);
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(Buffer.from(payload.data[0].b64_json, 'base64'), pngImage);
        assert.ok(Number.isSafeInteger(payload.created));
        assert.deepEqual(requested, ['https://chat.genai.um.edu.mo/api/v1/images/generations', 'https://chat.genai.um.edu.mo/api/v1/files/file-1/content']);
    } finally { harness.dispose(); }
});

test('image generation failures are forwarded unchanged', async () => {
    const harness = connectionHarness({ request: async () => new Response(JSON.stringify({ detail: 'Access prohibited' }),
        { status: 403, headers: { 'content-type': 'application/json' } }) });
    try {
        await harness.action('connect');
        const { request, response, chunks } = chatExchange('/v1/images/generations', '{"prompt":"a red apple"}');
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response);
        await finished;
        assert.equal(response.status, 403);
        assert.equal(Buffer.concat(chunks).toString(), '{"detail":"Access prohibited"}');
    } finally { harness.dispose(); }
});

test('cross-origin image file references are refused', async () => {
    const requested = [];
    const harness = connectionHarness({ request: async url => {
        requested.push(url);
        return new Response(JSON.stringify([{ id: 'file-1', url: 'https://evil.example/steal', name: 'x.png', content_type: 'image/png' }]),
            { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    try {
        await harness.action('connect');
        const { request, response } = chatExchange('/v1/images/generations', '{"prompt":"a red apple"}');
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response);
        await finished;
        assert.equal(response.status, 502);
        assert.deepEqual(requested, ['https://chat.genai.um.edu.mo/api/v1/images/generations']);
    } finally { harness.dispose(); }
});

test('image chat model turns the last user message into a generated image reply', async () => {
    const requested = [];
    const harness = connectionHarness({ request: async (url, settings) => {
        requested.push(url);
        if (url.endsWith('/api/v1/images/generations')) {
            assert.equal(JSON.parse(settings.body.toString()).prompt, 'a red apple');
            return new Response(JSON.stringify([{ id: 'file-1', url: '/api/v1/files/file-1/content', name: 'generated-image.png', content_type: 'image/png' }]),
                { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(pngImage, { status: 200, headers: { 'content-type': 'image/png' } });
    } });
    try {
        await harness.action('connect');
        const payload = { model: 'qwen-image-2.1', messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'a red apple' }] };
        const { request, response, chunks } = chatExchange('/v1/chat/completions', JSON.stringify(payload));
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response);
        await finished;
        assert.equal(response.status, 200);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.choices[0].message.role, 'assistant');
        assert.ok(body.choices[0].message.content.startsWith('![Qwen-Image](data:image/png;base64,'));
        assert.ok(body.choices[0].message.content.includes(pngImage.toString('base64')));
        assert.equal(body.choices[0].finish_reason, 'stop');
        assert.equal(body.usage, null);
        assert.equal(harness.snapshot().requests, 1);
        assert.equal(harness.snapshot().usageMissing, 1);
        assert.equal(harness.snapshot().usageReports, 0);
        assert.equal(harness.snapshot().tokensIn, 0);
        assert.equal(harness.snapshot().tokensOut, 0);
        assert.deepEqual(requested, ['https://chat.genai.um.edu.mo/api/v1/images/generations', 'https://chat.genai.um.edu.mo/api/v1/files/file-1/content']);
    } finally { harness.dispose(); }
});

test('image chat model streams the generated image as chat completion chunks', async () => {
    const harness = connectionHarness({ request: async url => url.endsWith('/api/v1/images/generations')
        ? new Response(JSON.stringify([{ id: 'file-1', url: '/api/v1/files/file-1/content', name: 'x.png', content_type: 'image/png' }]), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(pngImage, { status: 200, headers: { 'content-type': 'image/png' } }) });
    try {
        await harness.action('connect');
        const payload = { model: 'Qwen-Image-2.1', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'a red apple' }] };
        const { request, response, chunks } = chatExchange('/v1/chat/completions', JSON.stringify(payload));
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response);
        await finished;
        await nextTurn();
        assert.equal(response.status, 200);
        const text = Buffer.concat(chunks).toString();
        assert.ok(text.endsWith('data: [DONE]\n\n'));
        const events = text.split('\n\n').filter(Boolean).map(block => block.replace(/^data: /, '')).filter(data => data !== '[DONE]').map(data => JSON.parse(data));
        const streamed = events.filter(event => event.choices?.[0]?.delta?.content).map(event => event.choices[0].delta.content).join('');
        assert.ok(streamed.startsWith('![Qwen-Image](data:image/png;base64,'));
        assert.ok(streamed.includes(pngImage.toString('base64')));
        assert.equal(events.at(-2).choices[0].finish_reason, 'stop');
        assert.equal(events.at(-1).usage, null);
        assert.equal(harness.snapshot().usageReports, 0);
        assert.equal(harness.snapshot().usageMissing, 1);
    } finally { harness.dispose(); }
});

test('image chat model requires a text prompt and forwards upstream failures', async () => {
    const requested = [];
    const harness = connectionHarness({ request: async url => {
        requested.push(url);
        return new Response(JSON.stringify({ detail: 'Access prohibited' }),
            { status: 403, headers: { 'content-type': 'application/json' } });
    } });
    try {
        await harness.action('connect');
        for (const content of ['  ', [], [{ type: 'text', text: '  ' }], [{ type: 'image_url', image_url: { url: 'data:image/png;base64,UE5H' } }], null]) {
            const empty = chatExchange('/v1/chat/completions', JSON.stringify({ model: 'qwen-image', messages: [
                { role: 'user', content: 'an obsolete prompt' }, { role: 'user', content }
            ] }));
            const emptyDone = new Promise(resolve => empty.response.once('finish', resolve));
            harness.servers.at(-1).handle(empty.request, empty.response);
            await emptyDone;
            assert.equal(empty.response.status, 400);
        }
        assert.equal(requested.length, 0);
        const failure = chatExchange('/v1/chat/completions', JSON.stringify({ model: 'qwen-image', messages: [{ role: 'user', content: 'a red castle' }] }));
        const failureDone = new Promise(resolve => failure.response.once('finish', resolve));
        harness.servers.at(-1).handle(failure.request, failure.response);
        await failureDone;
        assert.equal(failure.response.status, 403);
        assert.equal(Buffer.concat(failure.chunks).toString(), '{"detail":"Access prohibited"}');
    } finally { harness.dispose(); }
});

test('image chat preserves text parts and image options and returns multiple detected image formats', async () => {
    const images = [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('RIFF0000WEBP'), Buffer.from('GIF89a')];
    const harness = connectionHarness({ request: async (url, settings) => {
        if (url.endsWith('/api/v1/images/generations')) {
            assert.deepEqual(JSON.parse(settings.body.toString()), { prompt: 'a red apple\non a blue table', n: 3, size: '1024x768' });
            return Response.json(images.map((image, index) => ({ url: `/api/v1/files/${index}/content` })));
        }
        return new Response(images[Number(url.split('/').at(-2))], { headers: { 'content-type': 'application/octet-stream' } });
    } });
    try {
        await harness.action('connect');
        const payload = { model: 'Qwen-Image-2.1', n: 3, size: '1024x768', tools: [{ type: 'function' }], messages: [
            { role: 'system', content: 'not a prompt' }, { role: 'user', content: 'obsolete' },
            { role: 'user', content: [{ type: 'text', text: 'a red apple' }, { type: 'text', text: 'on a blue table' }] },
            { role: 'assistant', content: 'also not a prompt' }
        ] };
        const { request, response, chunks } = chatExchange('/v1/chat/completions', JSON.stringify(payload));
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response);
        await finished;
        assert.equal(response.status, 200);
        const content = JSON.parse(Buffer.concat(chunks).toString()).choices[0].message.content;
        for (const mime of ['image/jpeg', 'image/webp', 'image/gif']) assert.ok(content.includes(`data:${mime};base64,`));
        for (const image of images) assert.ok(content.includes(image.toString('base64')));
    } finally { harness.dispose(); }
});

test('image chat retries one generation request after an unauthorized response', async () => {
    let attempts = 0;
    const harness = connectionHarness({ request: async url => {
        if (url.endsWith('/api/v1/images/generations')) {
            if (++attempts === 1) return new Response('expired', { status: 401 });
            return Response.json([{ url: '/api/v1/files/file-1/content' }]);
        }
        return new Response(pngImage);
    } });
    try {
        await harness.action('connect');
        const { request, response } = chatExchange('/v1/chat/completions', '{"model":"qwen-image-2.1","messages":[{"role":"user","content":"a red apple"}]}');
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response);
        await finished;
        assert.equal(response.status, 200);
        assert.equal(attempts, 2);
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.snapshot().requests, 1);
    } finally { harness.dispose(); }
});

test('image conversion rejects malformed references, excess files and non-image downloads', async () => {
    for (const scenario of [
        { payload: [] }, { payload: { detail: 'not an image result' } }, { payload: [null] }, { payload: [{ url: '' }] },
        { payload: [{ url: '/api/v1/auths/' }] }, { payload: [{ url: 'https://user:password@chat.genai.um.edu.mo/api/v1/files/file-1/content' }] },
        { payload: Array.from({ length: 7 }, () => ({ url: '/api/v1/files/file-1/content' })) },
        { payload: [{ url: '/api/v1/files/file-1/content' }], download: '<html>Login required</html>', downloads: 1 }
    ]) {
        let downloads = 0;
        const harness = connectionHarness({ request: async url => {
            if (url.endsWith('/api/v1/images/generations')) return Response.json(scenario.payload);
            downloads++;
            return new Response(scenario.download, { headers: { 'content-type': 'image/png' } });
        } });
        try {
            await harness.action('connect');
            const { request, response } = chatExchange('/v1/images/generations', '{"prompt":"a red apple"}');
            const finished = new Promise(resolve => response.once('finish', resolve));
            harness.servers.at(-1).handle(request, response);
            await finished;
            assert.equal(response.status, 502);
            assert.equal(downloads, scenario.downloads || 0);
        } finally { harness.dispose(); }
    }
});

test('image download limits apply to declared and streamed bytes and cancel oversized bodies', async () => {
    for (const declared of [true, false]) {
        let cancelled = false;
        const harness = connectionHarness({ request: async url => {
            if (url.endsWith('/api/v1/images/generations')) return Response.json([{ url: '/api/v1/files/file-1/content' }]);
            return new Response(new ReadableStream({
                start(controller) { if (!declared) controller.enqueue(Buffer.alloc(20 * 1024 * 1024 + 1)); },
                cancel() { cancelled = true; }
            }), { headers: declared ? { 'content-length': String(20 * 1024 * 1024 + 1) } : {} });
        } });
        try {
            await harness.action('connect');
            const { request, response } = chatExchange('/v1/images/generations', '{"prompt":"a red apple"}');
            const finished = new Promise(resolve => response.once('finish', resolve));
            harness.servers.at(-1).handle(request, response);
            await finished;
            assert.equal(response.status, 502);
            assert.equal(cancelled, true);
        } finally { harness.dispose(); }
    }
});

test('client disconnect cancels image download without disconnecting the shared session', async () => {
    let beginDownload, downloadSignal, cancelled = false;
    const downloading = new Promise(resolve => { beginDownload = resolve; });
    const harness = connectionHarness({ request: async (url, settings) => {
        if (url.endsWith('/api/v1/images/generations')) return Response.json([{ url: '/api/v1/files/file-1/content' }]);
        downloadSignal = settings.signal;
        return new Response(new ReadableStream({
            pull(controller) { controller.enqueue(pngImage); beginDownload(); return new Promise(() => {}); },
            cancel() { cancelled = true; }
        }));
    } });
    try {
        await harness.action('connect');
        const { request, response } = chatExchange('/v1/chat/completions', '{"model":"qwen-image-2.1","messages":[{"role":"user","content":"a red apple"}]}');
        harness.servers.at(-1).handle(request, response);
        await downloading;
        response.destroy();
        await nextTurn();
        assert.equal(downloadSignal.aborted, true);
        assert.equal(cancelled, true);
        assert.equal(harness.snapshot().connection, 'connected');
    } finally { harness.dispose(); }
});

test('late authentication cannot mark a replacement connection as connected', async () => {
    const completions = [];
    const harness = connectionHarness({ login: () => new Promise(resolve => completions.push(resolve)) });
    try {
        const first = harness.action('connect'); await nextTurn();
        await harness.action('disconnect');
        const replacement = harness.action('connect'); await nextTurn();
        completions.shift()(); await first;
        assert.equal(harness.snapshot().status, 'Authenticating');
        assert.equal(harness.snapshot().connectedAt, null);
        completions.shift()(); await replacement;
        assert.match(harness.snapshot().status, /^Connected/);
        assert.equal(harness.loginCalls[0][5], false);
    } finally { harness.dispose(); }
});

test('client cancellation during MFA releases request waiting without stopping shared login', async () => {
    let finishLogin;
    const harness = connectionHarness({ login: () => new Promise(resolve => { finishLogin = resolve; }) });
    try {
        const connecting = harness.action('connect'); await nextTurn();
        const { request, response } = chatExchange();
        harness.servers.at(-1).handle(request, response);
        await nextTurn();
        assert.equal(response.listenerCount('close'), 1);
        response.destroy(); await nextTurn();
        assert.equal(response.listenerCount('close'), 0);
        assert.equal(request.destroyed, true);
        assert.equal(harness.loginCalls[0][2].aborted, false);
        finishLogin(); await connecting;
        assert.match(harness.snapshot().status, /^Connected/);
    } finally { harness.dispose(); }
});

test('transient keepalive errors back off without launching MFA again', async () => {
    const harness = connectionHarness({ valid: async () => { throw Object.assign(new Error('503'), { code: 'SESSION_UNAVAILABLE' }); } });
    try {
        await harness.action('connect');
        assert.ok(harness.timers.at(-1).milliseconds > 119000 && harness.timers.at(-1).milliseconds <= 120000);
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 1);
        assert.ok(harness.timers.at(-1).milliseconds > 29000 && harness.timers.at(-1).milliseconds <= 30000);
        assert.equal(harness.snapshot().keepalive.state, 'error');
    } finally { harness.dispose(); }
});

test('503 health check during successful chat traffic must not mark the session expired', async () => {
    const { Session } = require('../auth');
    const checking = new Session();
    checking.request = async () => new Response('{"detail":"Service Unavailable"}', {
        status: 503, headers: { 'content-type': 'application/json' }
    });
    const harness = connectionHarness({ valid: signal => checking.valid(signal) });
    try {
        await harness.action('connect');
        for (let attempt = 0; attempt < 2; attempt++) {
            const { request, response } = chatExchange();
            const finished = new Promise(resolve => response.once('finish', resolve));
            harness.servers.at(-1).handle(request, response);
            await finished;
            if (attempt === 0) await harness.timers.at(-1).callback();
        }
        assert.equal(harness.loginCalls.length, 1);
        assert.equal(harness.snapshot().connection, 'connected');
        assert.notEqual(harness.snapshot().keepalive.state, 'reauthenticating');
        assert.equal(harness.snapshot().requests, 2);
    } finally { harness.dispose(); }
});

test('a delayed unauthorized health result cannot override newer successful upstream traffic', async () => {
    let finishCheck;
    const harness = connectionHarness({ valid: () => new Promise(resolve => { finishCheck = resolve; }) });
    try {
        await harness.action('connect');
        const checking = harness.timers.at(-1).callback();
        const { request, response } = chatExchange();
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response); await finished;
        finishCheck(false); await checking;
        assert.equal(harness.loginCalls.length, 1);
        assert.equal(harness.snapshot().keepalive.state, 'healthy');
        assert.equal(harness.snapshot().connection, 'connected');
    } finally { harness.dispose(); }
});

test('keepalive honors server rate limits without starting another login', async () => {
    const harness = connectionHarness({ valid: async () => { throw Object.assign(new Error('rate limit'), { code: 'SESSION_UNAVAILABLE', status: 429, retryAfterMs: 180000 }); } });
    try {
        await harness.action('connect');
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 1);
        assert.ok(harness.timers.at(-1).milliseconds > 179000 && harness.timers.at(-1).milliseconds <= 180000);
    } finally { harness.dispose(); }
});

test('existing stream completion cannot hide genuine authentication expiry', async () => {
    let finishCheck, finishStream;
    const harness = connectionHarness({ valid: () => new Promise(resolve => { finishCheck = resolve; }),
        request: async () => new Response(new ReadableStream({ start(controller) {
            finishStream = () => { controller.enqueue(Buffer.from('data: [DONE]\n\n')); controller.close(); };
        } }), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
        await harness.action('connect');
        const { request, response } = chatExchange();
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response); await nextTurn();
        const checking = harness.timers.at(-1).callback();
        finishStream(); await finished;
        finishCheck(false); await checking;
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.snapshot().keepalive.state, 'healthy');
    } finally { harness.dispose(); }
});

test('transient automatic reauthentication failure retries after cooldown without manual reconnect', async () => {
    let logins = 0;
    const harness = connectionHarness({ valid: async () => false, login: async () => {
        if (++logins === 2) throw Object.assign(new Error('gateway unavailable'), {
            code: 'SESSION_UNAVAILABLE', status: 503, retryAfterMs: 60000
        });
    } });
    try {
        await harness.action('connect');
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.snapshot().keepalive.state, 'retrying');
        assert.ok(harness.timers.at(-1).milliseconds > 59000 && harness.timers.at(-1).milliseconds <= 60000);
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 3);
        assert.equal(harness.snapshot().keepalive.state, 'healthy');
        assert.equal(harness.snapshot().connection, 'connected');
    } finally { harness.dispose(); }
});

test('failed automatic reauthentication does not create repeated MFA attempts', async () => {
    let logins = 0;
    const harness = connectionHarness({ valid: async () => false, login: async () => {
        if (++logins > 1) throw Object.assign(new Error('MFA incomplete'), { name: 'TimeoutError' });
    } });
    try {
        await harness.action('connect');
        const timer = harness.timers.at(-1);
        await timer.callback(); await timer.callback();
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.snapshot().keepalive.state, 'needs-login');
        assert.equal(harness.snapshot().keepalive.nextCheckAt, null);
        assert.equal(harness.snapshot().active, true);
        const { request, response } = chatExchange();
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response); await finished;
        assert.equal(response.status, 401);
        assert.equal(harness.loginCalls.length, 2);
    } finally { harness.dispose(); }
});

test('repeated unavailable health checks attempt one browser recovery per outage', async () => {
    let available = false;
    const harness = connectionHarness({ valid: async () => {
        if (!available) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
        return true;
    } });
    try {
        await harness.action('connect');
        for (let attempt = 0; attempt < 2; attempt++) {
            await harness.timers.at(-1).callback();
            assert.equal(harness.loginCalls.length, 1);
        }
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.loginCalls[1][7].force, true);
        for (let attempt = 0; attempt < 4; attempt++) await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 2);
        available = true;
        await harness.timers.at(-1).callback();
        available = false;
        for (let attempt = 0; attempt < 3; attempt++) await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 3);
    } finally { harness.dispose(); }
});

test('health recovery never bypasses rate limits or forbidden responses', async () => {
    for (const failure of [{ status: 429 }, { status: 403 }, { status: 503, retryAfterMs: 180000 }]) {
        const harness = connectionHarness({ valid: async () => {
            throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', ...failure });
        } });
        try {
            await harness.action('connect');
            for (let attempt = 0; attempt < 4; attempt++) await harness.timers.at(-1).callback();
            assert.equal(harness.loginCalls.length, 1);
            assert.equal(harness.snapshot().keepalive.state, 'error');
        } finally { harness.dispose(); }
    }
});

test('request-triggered reauthentication failure returns 503 with cooldown and automatically recovers', async () => {
    let logins = 0, requests = 0;
    const harness = connectionHarness({ login: async () => {
        if (++logins === 2) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }, request: async () => {
        requests++;
        return new Response(logins < 3 ? '{}' : 'data: [DONE]\n\n', {
            status: logins < 3 ? 401 : 200, headers: { 'content-type': 'text/event-stream' }
        });
    } });
    try {
        await harness.action('connect');
        for (let attempt = 0; attempt < 2; attempt++) {
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response);
            await finished;
            assert.equal(exchange.response.status, 503);
            assert.ok(Number(exchange.response.headers['retry-after']) >= 29);
            assert.equal(harness.loginCalls.length, 2);
            assert.equal(requests, 1);
        }
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 3);
        assert.equal(harness.snapshot().connection, 'connected');
        const exchange = chatExchange();
        const finished = new Promise(resolve => exchange.response.once('finish', resolve));
        harness.servers[0].handle(exchange.request, exchange.response);
        await finished;
        assert.equal(exchange.response.status, 200);
        assert.equal(requests, 2);
    } finally { harness.dispose(); }
});

test('automatic reauthentication retries are bounded even for persistent temporary failures', async () => {
    let logins = 0;
    const harness = connectionHarness({ valid: async () => false, login: async () => {
        if (++logins > 1) throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', status: 503 });
    } });
    try {
        await harness.action('connect');
        for (let attempt = 0; attempt < 3; attempt++) await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 4);
        assert.equal(harness.snapshot().keepalive.state, 'needs-login');
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 4);
    } finally { harness.dispose(); }
});

test('post-submission transport failures do not automatically repeat MFA', async () => {
    let logins = 0;
    const harness = connectionHarness({ valid: async () => false, login: async () => {
        if (++logins > 1) throw Object.assign(new Error('callback unavailable'), {
            code: 'SESSION_UNAVAILABLE', status: 503, retryAuthentication: false
        });
    } });
    try {
        await harness.action('connect');
        const timer = harness.timers.at(-1);
        await timer.callback(); await timer.callback();
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(harness.snapshot().keepalive.state, 'needs-login');
    } finally { harness.dispose(); }
});

test('Connect recovers a blocked session without disconnecting existing streams or resetting usage', async () => {
    let logins = 0, finishStream;
    const harness = connectionHarness({ valid: async () => false, login: async () => {
        if (++logins === 2) throw Object.assign(new Error('MFA incomplete'), { name: 'TimeoutError' });
    }, request: async () => new Response(new ReadableStream({ start(controller) {
        finishStream = () => { controller.enqueue(Buffer.from('data: [DONE]\n\n')); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
        await harness.action('connect');
        const exchange = chatExchange();
        const finished = new Promise(resolve => exchange.response.once('finish', resolve));
        harness.servers[0].handle(exchange.request, exchange.response); await nextTurn();
        await harness.timers.at(-1).callback();
        assert.equal(harness.snapshot().keepalive.state, 'needs-login');
        await harness.action('connect');
        assert.equal(harness.loginCalls.length, 3);
        assert.equal(harness.loginCalls[2][7].force, true);
        assert.equal(harness.loginCalls[0][2].aborted, false);
        assert.equal(harness.servers.length, 1);
        assert.equal(harness.snapshot().requests, 1);
        assert.equal(exchange.response.destroyed, false);
        assert.equal(harness.snapshot().connection, 'connected');
        finishStream(); await finished;
    } finally { harness.dispose(); }
});

test('a stale parallel 401 uses the refreshed session without starting another login', async () => {
    let requests = 0, releaseStale;
    const harness = connectionHarness({ request: async () => {
        requests++;
        if (requests === 1) return new Promise(resolve => { releaseStale = () => resolve(new Response('{}', { status: 401 })); });
        return new Response(requests === 2 ? '{}' : 'data: [DONE]\n\n', {
            status: requests === 2 ? 401 : 200, headers: { 'content-type': 'text/event-stream' }
        });
    } });
    try {
        await harness.action('connect');
        const first = chatExchange();
        const firstFinished = new Promise(resolve => first.response.once('finish', resolve));
        harness.servers[0].handle(first.request, first.response); await nextTurn();
        const second = chatExchange();
        const secondFinished = new Promise(resolve => second.response.once('finish', resolve));
        harness.servers[0].handle(second.request, second.response); await secondFinished;
        assert.equal(harness.loginCalls.length, 2);
        releaseStale(); await firstFinished;
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(first.response.status, 200);
        assert.equal(second.response.status, 200);
        assert.equal(requests, 4);
    } finally { harness.dispose(); }
});

test('a stale health check cannot replace a newly authenticated session after an upstream 503', async () => {
    for (const unavailable of [false, true]) {
        let finishCheck, requests = 0;
        const harness = connectionHarness({ valid: () => new Promise((resolve, reject) => {
            finishCheck = () => unavailable ? reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })) : resolve(false);
        }), request: async () => new Response('{}', { status: ++requests === 1 ? 401 : 503 }) });
        try {
            await harness.action('connect');
            const checking = harness.timers.at(-1).callback();
            const exchange = chatExchange();
            const finished = new Promise(resolve => exchange.response.once('finish', resolve));
            harness.servers[0].handle(exchange.request, exchange.response); await finished;
            assert.equal(exchange.response.status, 503);
            assert.equal(harness.loginCalls.length, 2);
            finishCheck(); await checking;
            assert.equal(harness.loginCalls.length, 2);
            assert.equal(harness.snapshot().keepalive.state, 'healthy');
            assert.equal(harness.snapshot().connection, 'connected');
        } finally { harness.dispose(); }
    }
});

test('diagnostic reauthentication closes the previous retained browser first', async () => {
    let closed = 0;
    const harness = connectionHarness({ valid: async () => false, login: async () => async () => { closed++; } });
    try {
        await harness.action('diagnose');
        assert.equal(harness.loginCalls[0][5], true);
        await harness.timers.at(-1).callback();
        assert.equal(harness.loginCalls.length, 2);
        assert.equal(closed, 1);
        assert.equal(harness.loginCalls[1][7].force, true);
    } finally { harness.dispose(); }
});

test('duplicate connection actions do not launch another login', async () => {
    let finishLogin;
    const harness = connectionHarness({ login: () => new Promise(resolve => { finishLogin = resolve; }) });
    try {
        const connecting = harness.action('connect'); await nextTurn();
        await harness.action('connect'); await harness.action('diagnose');
        assert.equal(harness.loginCalls.length, 1);
        assert.deepEqual([...harness.snapshot().pendingActions], ['connect']);
        finishLogin(); await connecting;
        assert.deepEqual([...harness.snapshot().pendingActions], []);
    } finally { harness.dispose(); }
});

test('clearing credentials requires confirmation and does not delete history', async () => {
    for (const answer of [undefined, '清除凭据']) {
        const deleted = [];
        const harness = connectionHarness({ confirm: async (message, options) => {
            assert.equal(options.modal, true);
            assert.match(options.detail, /历史用量保留/);
            return answer;
        }, delete: async key => deleted.push(key) });
        try {
            await harness.action('connect');
            await harness.action('clear');
            assert.deepEqual(deleted, answer ? ['credentials', 'session'] : []);
            assert.equal(harness.snapshot().connection, answer ? 'disconnected' : 'connected');
        } finally { harness.dispose(); }
    }
});

test('clear confirmation cannot delete a newly connected session', async () => {
    let confirm;
    const deleted = [];
    const harness = connectionHarness({ confirm: () => new Promise(resolve => { confirm = resolve; }), delete: async key => deleted.push(key) });
    try {
        await harness.action('connect');
        const clearing = harness.action('clear'); await nextTurn();
        await harness.action('disconnect');
        confirm('清除凭据'); await clearing;
        assert.deepEqual(deleted, []);
    } finally { harness.dispose(); }
});

test('credentials are not written when ownership changes during input', async () => {
    const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
    const start = source.indexOf('const credentials = async () =>');
    const end = source.indexOf('const connectNow =', start);
    for (const owner of ['local', 'other']) {
        let checks = 0;
        const sandbox = {
            active: undefined,
            connectionVersion: 0, syncDisposed: false,
            requireOwner: async () => {
                checks++;
                if (checks === 2 && owner === 'local') sandbox.active = {};
                return checks !== 2 || owner !== 'other';
            },
            vscode: { window: { showInputBox: async () => 'test' } },
            context: { secrets: { store: () => assert.fail('must not overwrite credentials'), delete: () => assert.fail('must not clear session') } }
        };
        const result = vm.runInNewContext(source.slice(start, end) + 'credentials()', sandbox);
        if (owner === 'local') await assert.rejects(result, /Disconnect/);
        else assert.equal(await result, false);
        assert.equal(checks, 2);
    }
});

test('connection initialization failure clears active state and permits retry', async () => {
    const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
    const start = source.indexOf('const connectNow = async (');
    const end = source.indexOf('let configuringModels', start);
    assert.ok(start >= 0 && end > start);
    let loads = 0;
    const sandbox = {
        AbortController,
        syncSharedState: async () => {},
        startListener: async () => true,
        syncDisposed: false, connectionVersion: 0,
        getHistory: () => ({ reload: async () => {} }),
        output: { show() {} }, trace() {}, status() {},
        transportCode: require('../bridge-stream').transportCode,
        context: { secrets: { get: async () => '{"username":"test","password":"dummy"}' } },
        require: () => { loads++; throw new Error('dependency failed'); }
    };
    vm.runInNewContext('let active, sharedState, connectPromise, listenerReady = false, automaticLoginBlocked = false, automaticRetryAt = 0, automaticFailures = 0; const stop = () => { active?.abort(); active = undefined; connectPromise = undefined; };' + source.slice(start, end) + 'globalThis.connect = connect; globalThis.isActive = () => Boolean(active);', sandbox);
    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(sandbox.connect(), /dependency failed/);
        assert.equal(sandbox.isActive(), false);
    }
    assert.equal(loads, 2);
});

test('visible diagnostic login requires ownership and an idle connection', async () => {
    const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
    const start = source.indexOf('const diagnose = async () =>');
    const end = source.indexOf('const actions =', start);
    assert.ok(start >= 0 && end > start);
    for (const state of ['observer', 'active', 'idle']) {
        const calls = [];
        const notices = [];
        const sandbox = {
            requireOwner: async () => state !== 'observer',
            active: state === 'active' ? {} : undefined,
            connect: async diagnostic => calls.push(diagnostic),
            vscode: { window: { showInformationMessage: async message => notices.push(message) } }
        };
        await vm.runInNewContext(source.slice(start, end) + 'diagnose()', sandbox);
        assert.deepEqual(calls, state === 'idle' ? [true] : []);
        assert.equal(notices.length, state === 'active' ? 1 : 0);
    }
});

test('startup registration and initial snapshot do not require a message round trip', () => {
    const manifest = require('../package.json');
    assert.ok(manifest.activationEvents.includes('onStartupFinished'));
    const snapshot = { status: '</script><script>bad()</script>', port: 58379, models: [] };
    const html = require('../dashboard').dashboardHtml(snapshot);
    assert.ok(!html.includes(snapshot.status));
    const serialized = html.match(/const initialState = (.*);/)[1];
    assert.deepEqual(JSON.parse(serialized), snapshot);
    assert.ok(html.includes('if (initialState) render(initialState)'));
    assert.ok(html.includes('data-command="diagnose"'));
    assert.ok(html.includes(`<span class="version-tag" title="GENAI Login v${manifest.version}">v${manifest.version}</span>`));
    assert.ok(html.indexOf('data-command="clear"') < html.indexOf('data-command="diagnose"'));
});

test('port action validates, cancels, resets and saves only user settings', async () => {
    const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
    const start = source.indexOf('const port = async () =>');
    const end = source.indexOf('const actions =', start);
    for (const value of [undefined, '', '58480']) {
        const updates = [];
        const notices = [];
        const vscode = {
            ConfigurationTarget: { Global: 1 },
            workspace: { getConfiguration: () => ({ get: () => 58379, update: async (...args) => updates.push(args) }) },
            window: {
                showInputBox: async options => {
                    for (const valid of ['', '1024', '65535', ' 58480 ']) assert.equal(options.validateInput(valid), undefined);
                    for (const invalid of ['1023', '65536', '12.3', '-1', 'abc']) assert.ok(options.validateInput(invalid));
                    return value;
                },
                showInformationMessage: async message => notices.push(message),
                showErrorMessage: message => assert.fail(message)
            }
        };
        await vm.runInNewContext(source.slice(start, end) + 'port()', { vscode, stats: { port: 58379 } });
        assert.equal(updates.length, value === undefined ? 0 : 1);
        if (updates.length) {
            assert.equal(updates[0][0], 'port');
            assert.equal(updates[0][1], value === '' ? undefined : 58480);
            assert.equal(updates[0][2], 1);
            assert.ok(notices[0].includes('当前连接不变'));
        }
    }
    assert.ok(require('../dashboard').dashboardHtml().includes('data-command="port"'));
});

test('observer yields the occupied port and synchronizes without loading authentication or changing credentials', async () => {
    const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
    const commands = new Map();
    const messages = [];
    const subscriptions = [];
    let provider, poll, unavailable = false, notices = 0, timerCleared = false;
    let fetches = 0, visibilityChanged, viewDisposed, pending = false, pendingSignal;
    const snapshot = { status: 'Connected :58480', port: 58480, connectedAt: 100,
        requests: 12, tokensIn: 34, tokensOut: 56, usageReports: 2, usageMissing: 0,
        models: [{ name: 'test-model', requests: 12 }], keepalive: { state: 'healthy', lastCheckAt: 200 } };
    const disposable = { dispose() {} };
    const fakeVscode = {
        workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'port' ? 58480 : fallback }) },
        window: {
            createOutputChannel: () => ({ ...disposable, appendLine() {}, show() {} }),
            registerWebviewViewProvider: (name, value, options) => {
                assert.equal(options.webviewOptions.retainContextWhenHidden, false);
                provider = value; return disposable;
            },
            showInformationMessage: async () => { notices++; },
            showErrorMessage: () => assert.fail('unexpected error'),
            showInputBox: () => assert.fail('observer must not request credentials')
        },
        commands: { registerCommand: (name, action) => { commands.set(name, action); return disposable; } }
    };
    const sandbox = {
        module: { exports: {} }, AbortController, AbortSignal,
        setTimeout, clearTimeout,
        setInterval: callback => { poll = callback; return { unref() {} }; },
        clearInterval: () => { timerCleared = true; poll = undefined; },
        fetch: async (url, options) => {
            fetches++;
            if (pending) {
                pendingSignal = options.signal;
                return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
            }
            assert.equal(url, 'http://127.0.0.1:58480/internal/status');
            assert.equal(options.headers.Authorization, 'Bearer local-browser-session');
            if (unavailable) throw new Error('connection refused');
            return { ok: true, json: async () => ({ service: 'genai-login', version: 1, state: snapshot }) };
        },
        require: name => {
            assert.ok(!['undici', './upstream', './auth', './browser-auth'].includes(name), `Observer loaded heavy dependency: ${name}`);
            if (name === 'vscode') return fakeVscode;
            if (name === 'node:http') return { createServer: () => {
                const server = Object.assign(new EventEmitter(), {
                    listen() { queueMicrotask(() => server.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }))); },
                    closeAllConnections() {}, close() {}
                });
                return server;
            } };
            return require(name.startsWith('./') ? '../' + name.slice(2) : name);
        }
    };
    vm.runInNewContext(source, sandbox);
    sandbox.module.exports.activate({ subscriptions, globalState: { keys: () => [], get() {}, update: async () => {} }, secrets: {
        get: () => assert.fail('observer must not read credentials'),
        store: () => assert.fail('observer must not write credentials'),
        delete: () => assert.fail('observer must not delete credentials')
    } });
    try {
        await nextTurn();
        assert.equal(fetches, 1);
        assert.equal(poll, undefined);
        assert.ok(commands.has('genai-login.diagnose'));
        assert.ok(require('../package.json').contributes.commands.some(command => command.command === 'genai-login.diagnose'));
        const view = { visible: false, webview: { postMessage: message => messages.push(message.data),
            onDidReceiveMessage: () => disposable },
            onDidChangeVisibility: callback => { visibilityChanged = callback; return disposable; },
            onDidDispose: callback => { viewDisposed = callback; return disposable; } };
        provider.resolveWebviewView(view);
        assert.equal(fetches, 1);
        view.visible = true; visibilityChanged();
        await nextTurn();
        assert.match(messages.at(-1).status, /shared window/);
        assert.equal(messages.at(-1).tokensOut, 56);
        assert.equal(messages.at(-1).models[0].name, 'test-model');
        for (const action of ['connect', 'diagnose', 'disconnect', 'credentials', 'clear']) await commands.get(`genai-login.${action}`)();
        assert.equal(notices, 4);
        snapshot.requests = 23;
        poll(); await nextTurn();
        assert.equal(messages.at(-1).requests, 23);
        pending = true;
        poll();
        view.visible = false; visibilityChanged();
        assert.equal(pendingSignal.aborted, true);
        assert.equal(poll, undefined);
        const hiddenFetches = fetches;
        await nextTurn();
        assert.equal(fetches, hiddenFetches);
        pending = false;
        snapshot.requests = 42;
        view.visible = true; visibilityChanged();
        await nextTurn();
        assert.equal(messages.at(-1).requests, 42);
        unavailable = true;
        poll(); await nextTurn();
        assert.equal(messages.at(-1).status, 'Disconnected');
        assert.equal(messages.at(-1).requests, 0);
        viewDisposed();
        assert.equal(poll, undefined);
    } finally {
        for (const subscription of subscriptions) subscription.dispose();
    }
    assert.equal(timerCleared, true);
});

test('local access permits none metadata but requires host and bearer without Origin', () => {
    const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
    const start = source.indexOf('const rejectLocalRequest =');
    const end = source.indexOf('const startListener =', start);
    assert.ok(start >= 0 && end > start);
    const check = (headers, port = 58379) => vm.runInNewContext(source.slice(start, end) + 'rejectLocalRequest(request)', { request: { headers }, stats: { port } });
    const base = { host: '127.0.0.1:58379', authorization: 'Bearer local-browser-session' };
    assert.equal(check(base), '');
    assert.equal(check({ ...base, host: '127.0.0.1:58480' }, 58480), '');
    assert.notEqual(check(base, 58480), '');
    assert.equal(check({ ...base, 'sec-fetch-site': 'none' }), '');
    for (const site of ['cross-site', 'same-site', 'same-origin', 'invalid']) {
        assert.notEqual(check({ ...base, 'sec-fetch-site': site }), '');
    }
    assert.notEqual(check({ ...base, origin: 'https://example.com' }), '');
    assert.notEqual(check({ ...base, authorization: 'wrong', 'sec-fetch-site': 'none' }), '');
    assert.notEqual(check({ ...base, authorization: undefined }), '');
    assert.notEqual(check({ ...base, host: 'example.com' }), '');
});