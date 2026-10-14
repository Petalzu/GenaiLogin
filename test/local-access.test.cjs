const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');

function connectionHarness(options = {}) {
    const commands = new Map();
    const messages = [];
    const subscriptions = [];
    const timers = [];
    const loginCalls = [];
    const servers = [];
    let provider;
    const disposable = { dispose() {} };
    const fakeVscode = {
        workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'idleTimeoutSeconds' ? options.idleSeconds || 0 : fallback }) },
        window: {
            createOutputChannel: () => ({ ...disposable, appendLine() {}, show() {} }),
            registerWebviewViewProvider: (name, value) => { provider = value; return disposable; },
            showInformationMessage: async () => {}, showErrorMessage: async () => {},
            showWarningMessage: options.confirm || (async () => undefined),
            showInputBox: () => assert.fail('unexpected credential input')
        },
        commands: { registerCommand: (name, action) => { commands.set(name, action); return disposable; } }
    };
    const fakeHttp = { createServer: handler => {
        const server = Object.assign(new EventEmitter(), { handle: handler,
            listen: (port, host, ready) => { queueMicrotask(ready); }, closeAllConnections() {}, close() {} });
        servers.push(server); return server;
    } };
    class Session {
        constructor() { this.jar = { toJSON: () => ({ cookies: [{ key: 'token', value: 'dummy' }] }) }; }
        valid(signal) { return options.valid ? options.valid(signal) : Promise.resolve(true); }
        request(url, settings) { return options.request ? options.request(url, settings) : Promise.resolve(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })); }
    }
    const secrets = {
        get: async key => key === 'credentials' ? '{"username":"test","password":"dummy"}' : undefined,
        store: options.store || (async () => {}), delete: options.delete || (async () => {})
    };
    const sandbox = {
        module: { exports: {} }, AbortController, AbortSignal, Buffer,
        setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds, unref() {} }; timers.push(timer); return timer; },
        clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
        fetch: async () => { throw new Error('no other owner'); },
        require: name => {
            if (name === 'vscode') return fakeVscode;
            if (name === 'node:http') return fakeHttp;
            if (name === 'undici') return { Agent: class { destroy() { return Promise.resolve(); } }, fetch() { assert.fail('unexpected network'); } };
            if (name === './auth') return { ...require('../auth'), Session };
            if (name === './browser-auth') return { browserLogin: async (...args) => { loginCalls.push(args); return options.login?.(...args); } };
            return require(name.startsWith('./') ? '../' + name.slice(2) : name);
        }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../extension.js'), 'utf8'), sandbox);
    sandbox.module.exports.activate({ subscriptions, secrets, globalState: { get() {}, keys: () => [], update: async () => {} } });
    provider.resolveWebviewView({ visible: false, webview: { postMessage: message => messages.push(message.data), onDidReceiveMessage: () => disposable },
        onDidChangeVisibility: () => disposable, onDidDispose: () => disposable });
    return { loginCalls, timers, servers, messages, secrets,
        action: name => commands.get(`genai-login.${name}`)(),
        snapshot: () => provider.getState(),
        dispose: () => { for (const item of subscriptions) item.dispose(); }
    };
}

function chatExchange() {
    const chunks = [];
    const response = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.writeHead = status => { response.status = status; response.headersSent = true; };
    const request = { method: 'POST', url: '/v1/chat/completions', headers: { host: '127.0.0.1:58379', authorization: 'Bearer local-browser-session' },
        destroy() { this.destroyed = true; }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"model":"test","stream":true}'); } };
    return { request, response, chunks };
}

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
        assert.equal(harness.snapshot().active, true);
        const { request, response } = chatExchange();
        const finished = new Promise(resolve => response.once('finish', resolve));
        harness.servers.at(-1).handle(request, response); await finished;
        assert.equal(response.status, 401);
        assert.equal(harness.loginCalls.length, 2);
    } finally { harness.dispose(); }
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
    const end = source.indexOf('const connect =', start);
    for (const owner of ['local', 'other']) {
        let checks = 0;
        const sandbox = {
            active: undefined,
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
    const start = source.indexOf('const connect = async (');
    const end = source.indexOf('let configuringModels', start);
    assert.ok(start >= 0 && end > start);
    let loads = 0;
    const sandbox = {
        AbortController,
        syncSharedState: async () => {},
        history: { reload: async () => {} },
        output: { show() {} }, trace() {}, status() {},
        context: { secrets: { get: async () => '{"username":"test","password":"dummy"}' } },
        require: () => { loads++; throw new Error('dependency failed'); }
    };
    vm.runInNewContext('let active, sharedState; const stop = () => { active?.abort(); active = undefined; };' + source.slice(start, end) + 'globalThis.connect = connect; globalThis.isActive = () => Boolean(active);', sandbox);
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

test('observer synchronizes owner state without opening a server or changing credentials', async () => {
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
            assert.ok(!['undici', './auth', './browser-auth'].includes(name), `Observer loaded heavy dependency: ${name}`);
            if (name === 'vscode') return fakeVscode;
            if (name === 'node:http') return { createServer: () => assert.fail('observer must not start server') };
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
        assert.equal(fetches, 0);
        assert.equal(poll, undefined);
        assert.ok(commands.has('genai-login.diagnose'));
        assert.ok(require('../package.json').contributes.commands.some(command => command.command === 'genai-login.diagnose'));
        const view = { visible: false, webview: { postMessage: message => messages.push(message.data),
            onDidReceiveMessage: () => disposable },
            onDidChangeVisibility: callback => { visibilityChanged = callback; return disposable; },
            onDidDispose: callback => { viewDisposed = callback; return disposable; } };
        provider.resolveWebviewView(view);
        assert.equal(fetches, 0);
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
    const start = source.indexOf('const fetchSite =');
    const end = source.indexOf('if (rejected)', start);
    assert.ok(start >= 0 && end > start);
    const check = (headers, port = 58379) => vm.runInNewContext(source.slice(start, end) + 'rejected', { request: { headers }, stats: { port } });
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