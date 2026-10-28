const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserLogin } = require('../browser-auth');
const fs = require('node:fs');
const vm = require('node:vm');
const { Session, ORIGIN } = require('../auth');

function isolatedHarness(mode) {
    const children = [];
    const modulePath = process.env.GENAI_BROWSER_MODULE || require.resolve('../browser-auth');
    const authPath = require('node:path').join(require('node:path').dirname(modulePath), 'auth.js');
    const source = fs.readFileSync(require.resolve('../browser-auth'), 'utf8');
    const setup = `
        const Module = require('node:module');
        const load = Module._load;
        const mode = ${JSON.stringify(mode)};
        const { Session, ORIGIN } = require(${JSON.stringify(authPath)});
        Session.prototype.valid = async function () { return (await this.jar.getCookieString(ORIGIN)).includes('worker-token'); };
        Module._load = function (name, parent, isMain) {
            if (name !== 'playwright-core') return load.call(this, name, parent, isMain);
            const { chromium } = load.call(this, name, parent, isMain);
            return { chromium: { launch: async options => {
                const browser = await chromium.launch(options);
                process.on('message', message => {
                    if (message.type === 'test-close-browser') void browser.close();
                });
                const newContext = browser.newContext.bind(browser);
                browser.newContext = async () => {
                    const context = await newContext();
                    await context.route('**/*', route => {
                        if (mode === 'failure') return route.abort('failed');
                        if (mode === 'unavailable') return route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'retry-after': '60' }, body: 'unavailable' });
                        return route.fulfill({ contentType: 'text/html; charset=utf-8',
                            headers: { 'set-cookie': 'token=worker-token; Path=/; Secure; HttpOnly; SameSite=Lax' }, body: '<p>Verified</p>' });
                    });
                    return context;
                };
                return browser;
            } } };
        };
        process.argv[1] = ${JSON.stringify(modulePath)};
        Module.runMain();
    `;
    const launchChild = (filename, args, options) => {
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', setup], options);
        children.push(child);
        return child;
    };
    const sandbox = { module: { exports: {} }, __filename: modulePath, AbortController, AbortSignal, URL, Buffer,
        process,
        require: name => name === 'node:child_process' ? { fork: launchChild } :
            require(name.startsWith('./') ? '../' + name.slice(2) : name) };
    vm.runInNewContext(source, sandbox);
    return { login: sandbox.module.exports.browserLogin, children };
}

test('authentication process startup failure rejects without waiting for an exit event', async () => {
    const { EventEmitter } = require('node:events');
    const source = fs.readFileSync(require.resolve('../browser-auth'), 'utf8');
    const sandbox = { module: { exports: {} }, __filename: require.resolve('../browser-auth'), AbortController, AbortSignal, URL, Buffer, process,
        require: name => name === 'node:child_process' ? { fork: () => {
            const child = Object.assign(new EventEmitter(), { send() {}, connected: false });
            queueMicrotask(() => {
                child.emit('error', Object.assign(new Error('spawn failed'), { code: 'EAGAIN' }));
                child.emit('close', -1);
            });
            return child;
        } } : require(name.startsWith('./') ? '../' + name.slice(2) : name) };
    vm.runInNewContext(source, sandbox);
    const session = new Session();
    session.valid = async () => false;
    await assert.rejects(sandbox.module.exports.browserLogin(session, {}), { code: 'EAGAIN' });
});

test('isolated Edge login returns cookies and releases the Playwright process after ordinary login', { timeout: 20000 }, async () => {
    const harness = isolatedHarness('success');
    const session = new Session();
    session.valid = async () => false;
    const traces = [];
    try {
        await harness.login(session, { username: 'test', password: 'dummy' }, AbortSignal.timeout(15000), message => traces.push(message));
        assert.ok((await session.jar.getCookieString(ORIGIN)).includes('worker-token'));
        assert.equal(harness.children[0].exitCode, 0);
        assert.ok(traces.includes('Browser session verified'));
        assert.ok(traces.includes('Temporary Edge closed'));
        assert.ok(!Object.keys(require.cache).some(path => path.includes('playwright-core')));
    } finally { for (const child of harness.children) if (child.exitCode === null) child.kill(); }
});

test('isolated diagnostic browser and process are released by idempotent close', { timeout: 20000 }, async () => {
    const harness = isolatedHarness('success');
    const session = new Session();
    const controller = new AbortController();
    try {
        const close = await harness.login(session, {}, controller.signal, () => {}, undefined, true, true);
        assert.equal(harness.children[0].exitCode, null);
        await close(); await close(); controller.abort();
        assert.equal(harness.children[0].exitCode, 0);
        assert.ok((await session.jar.getCookieString(ORIGIN)).includes('worker-token'));
    } finally { controller.abort(); for (const child of harness.children) if (child.exitCode === null) child.kill(); }
});

test('manually closing diagnostic Edge releases its process without requiring disconnect', { timeout: 20000 }, async () => {
    const harness = isolatedHarness('success');
    const controller = new AbortController();
    try {
        const close = await harness.login(new Session(), {}, controller.signal, () => {}, undefined, true, true);
        const child = harness.children[0];
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.send({ type: 'test-close-browser' });
        await exited;
        assert.equal(child.exitCode, 0);
        await close();
    } finally { controller.abort(); for (const child of harness.children) if (child.exitCode === null) child.kill(); }
});

test('isolated login cancellation and navigation failures terminate processes without publishing cookies', { timeout: 45000 }, async () => {
    for (const cancelled of [true, false]) {
        const harness = isolatedHarness('failure');
        const session = new Session();
        session.valid = async () => false;
        const controller = new AbortController();
        try {
            const pending = harness.login(session, {}, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), message => {
                if (cancelled && message === 'Starting temporary headless Edge') controller.abort();
            });
            await assert.rejects(pending);
            assert.equal(harness.children[0].exitCode, 0);
            assert.equal(await session.jar.getCookieString(ORIGIN), '');
        } finally { controller.abort(); for (const child of harness.children) if (child.exitCode === null) child.kill(); }
    }
});

test('isolated authentication errors preserve recovery safety, status and Retry-After', { timeout: 20000 }, async () => {
    const harness = isolatedHarness('unavailable');
    const session = new Session();
    session.valid = async () => false;
    const traces = [];
    try {
        await assert.rejects(harness.login(session, {}, AbortSignal.timeout(15000), message => traces.push(message)), {
            code: 'SESSION_UNAVAILABLE', status: 503, retryAfterMs: 60000, retryAuthentication: true
        });
        assert.equal(harness.children[0].exitCode, 0);
        assert.equal(await session.jar.getCookieString(ORIGIN), '');
    } catch (error) {
        error.message += `; stages=${JSON.stringify(traces)}`;
        throw error;
    } finally { for (const child of harness.children) if (child.exitCode === null) child.kill(); }
});

test('diagnostic browser stays open until disconnect', async () => {
    let closed = false;
    const controller = new AbortController();
    const page = { on: () => {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => page, cookies: async () => [{ name: 'token', value: 'test', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => true, jar: { setCookie: async () => {} } }, {}, controller.signal, () => {}, { launch: async () => browser }, true);
    assert.equal(closed, false);
    controller.abort();
    assert.equal(closed, true);
});
test('visible diagnostic login retains Edge until disconnect', async () => {
    let closed = false;
    let launchOptions;
    const traces = [];
    const controller = new AbortController();
    const page = { on: () => {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => page, cookies: async () => [{ name: 'token', value: 'test', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => true, jar: { setCookie: async () => {} } }, {}, controller.signal, message => traces.push(message), { launch: async options => { launchOptions = options; return browser; } }, true, false);
    assert.equal(launchOptions.headless, false);
    assert.ok(traces.includes('Starting temporary visible Edge (diagnostic)'));
    assert.equal(closed, false);
    controller.abort();
    assert.equal(closed, true);
});
test('saved session does not launch Edge', async () => {
    await browserLogin({ valid: async () => true }, {}, undefined, () => {}, { launch: () => assert.fail('unexpected launch') });
});
test('valid saved session does not even load Playwright', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../browser-auth'))}).browserLogin({valid: async () => true}, {}).then(() => { if (Object.keys(require.cache).some(file => file.includes('playwright-core'))) process.exitCode = 1; });`]);
    assert.equal(result.status, 0, result.stderr?.toString());
});
test('transient session check failure does not start a new login', async () => {
    await assert.rejects(browserLogin({ valid: async () => { throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE' }); } }, {}, undefined, () => {}, { launch: () => assert.fail('unexpected launch') }), { code: 'SESSION_UNAVAILABLE' });
});
test('saved session check retries gateway and transport failures without opening a browser', async () => {
    let checks = 0;
    await browserLogin({ valid: async () => {
        checks++;
        if (checks === 1) throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', status: 503 });
        if (checks === 2) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return true;
    } }, {}, AbortSignal.timeout(10000), () => {}, { launch: () => assert.fail('unexpected launch') });
    assert.equal(checks, 3);
});
test('explicit reconnect can open the home page after bounded saved-session failures', async () => {
    let checks = 0;
    let closed = 0;
    const visits = [];
    const page = { on() {}, goto: async url => { visits.push(url); }, url: () => ORIGIN + '/', locator: () => ({}) };
    const browser = { close: async () => { closed++; }, newContext: async () => ({ newPage: async () => page,
        cookies: async () => [{ name: 'token', value: 'fresh', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => {
        if (++checks <= 3) throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', status: 503 });
        return true;
    }, jar: { setCookie: async () => {} } }, {}, AbortSignal.timeout(10000), () => {}, { launch: async () => browser }, false, true, { recoverSession: true });
    assert.equal(checks, 4);
    assert.deepEqual(visits, [ORIGIN + '/']);
    assert.equal(closed, 1);
});
test('automatic saved-session failure remains bounded without launching MFA', async () => {
    let checks = 0;
    await assert.rejects(browserLogin({ valid: async () => {
        checks++;
        throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', status: 503 });
    } }, {}, AbortSignal.timeout(10000), () => {}, { launch: () => assert.fail('unexpected launch') }), { code: 'SESSION_UNAVAILABLE', status: 503 });
    assert.equal(checks, 3);
});
test('saved-session recovery respects rate limits, forbidden responses and cancellation', async () => {
    for (const failure of [{ status: 403 }, { status: 429 }, { status: 503, retryAfterMs: 60000 }]) {
        let checks = 0;
        await assert.rejects(browserLogin({ valid: async () => {
            checks++;
            throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', ...failure });
        } }, {}, undefined, () => {}, { launch: () => assert.fail('unexpected launch') }, false, true, { recoverSession: true }), { code: 'SESSION_UNAVAILABLE', ...failure });
        assert.equal(checks, 1);
    }
    const controller = new AbortController();
    let checks = 0;
    await assert.rejects(browserLogin({ valid: async () => {
        checks++;
        throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', status: 503 });
    } }, {}, controller.signal, message => { if (message.includes('retry')) controller.abort(); },
    { launch: () => assert.fail('unexpected launch') }, false, true, { recoverSession: true }), { name: 'AbortError' });
    assert.equal(checks, 1);
});
test('explicit reconnect observes the final Retry-After before opening the home page', async () => {
    const controller = new AbortController();
    let checks = 0;
    let cancellation;
    try {
        await assert.rejects(browserLogin({ valid: async () => {
            checks++;
            throw Object.assign(new Error('unavailable'), { code: 'SESSION_UNAVAILABLE', status: 503, retryAfterMs: 100 });
        } }, {}, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), message => {
            if (message.startsWith('Saved session check unavailable')) cancellation = setTimeout(() => controller.abort(), 10);
        }, { launch: () => assert.fail('browser opened before Retry-After') }, false, true, { recoverSession: true }), { name: 'AbortError' });
        assert.equal(checks, 3);
    } finally { clearTimeout(cancellation); controller.abort(); }
});
test('forced ordinary login closes Edge after verification', async () => {
    let closed = 0;
    let checks = 0;
    const page = { on() {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed++; }, newContext: async () => ({ newPage: async () => page,
        cookies: async () => [{ name: 'token', value: 'dummy', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => { checks++; return true; }, jar: { setCookie: async () => {} } }, {}, undefined, () => {}, { launch: async () => browser }, false, true, { force: true });
    assert.equal(checks, 1);
    assert.equal(closed, 1);
});
test('retained diagnostic browser has an idempotent explicit cleanup', async () => {
    let closed = 0;
    const controller = new AbortController();
    const page = { on() {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed++; }, newContext: async () => ({ newPage: async () => page,
        cookies: async () => [{ name: 'token', value: 'dummy', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    const close = await browserLogin({ valid: async () => true, jar: { setCookie: async () => {} } }, {}, controller.signal, () => {}, { launch: async () => browser }, true, false);
    await close(); await close(); controller.abort();
    assert.equal(closed, 1);
});
test('browser closes on navigation failure', async () => {
    let closed = false;
    const traces = [];
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => ({ on: () => {}, goto: async () => { throw new Error('navigation failed'); } }) }) };
    await assert.rejects(browserLogin({ valid: async () => false }, {}, undefined, message => traces.push(message), { launch: async () => browser }), /navigation failed/);
    assert.ok(closed);
    assert.ok(traces.includes('Browser login failed: phase=webui-entry code=Error'));
    assert.ok(!traces.some(message => message.includes('navigation failed')));
});
test('verified cookies survive browser closure', async () => {
    let checks = 0; let closed = false; let imported;
    const page = { on: () => {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => page, cookies: async () => [{ name: 'token', value: 'test', domain: 'chat.genai.um.edu.mo', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => ++checks > 1, jar: { setCookie: async cookie => { imported = cookie; } } }, {}, undefined, () => {}, { launch: async () => browser });
    assert.equal(imported.value, 'test'); assert.ok(closed);
});
test('callback verification recovers a connection reset without restarting browser authentication', async () => {
    let checks = 0;
    let navigations = 0;
    let closed = 0;
    const page = { on() {}, goto: async () => { navigations++; }, url: () => ORIGIN + '/', locator: () => ({}) };
    const browser = { close: async () => { closed++; }, newContext: async () => ({ newPage: async () => page,
        cookies: async () => [{ name: 'token', value: 'fresh', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ jar: { setCookie: async () => {} }, valid: async () => {
        if (++checks === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return true;
    } }, {}, AbortSignal.timeout(5000), () => {}, { launch: async () => browser }, false, true, { force: true });
    assert.equal(checks, 2);
    assert.equal(navigations, 1);
    assert.equal(closed, 1);
});
test('identity diagnostics log route categories without authentication parameters', async () => {
    const traces = [];
    const listeners = new Map();
    const secret = 'private-authentication-value';
    const url = `https://login.um.edu.mo/auth/realms/private-realm/login-actions/required-action?code=${secret}#${secret}`;
    const frame = { url: () => url };
    const request = { url: () => url, frame: () => frame, isNavigationRequest: () => true, failure: () => ({ errorText: `net::ERR_CONNECTION_RESET ${secret}` }) };
    const page = {
        on: (event, handler) => listeners.set(event, handler), mainFrame: () => frame,
        url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}),
        goto: async () => {
            listeners.get('framenavigated')(frame);
            listeners.get('response')({ request: () => request, frame: () => frame, url: () => url, status: () => 400 });
            listeners.get('requestfailed')(request);
        }
    };
    let checks = 0;
    const browser = { close: async () => {}, newContext: async () => ({ newPage: async () => page, cookies: async () => [{ name: 'token', value: secret, domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => ++checks > 1, jar: { setCookie: async () => {} } }, {}, undefined, message => traces.push(message), { launch: async () => browser });
    assert.ok(traces.includes('Authentication navigation: host=login.um.edu.mo route=required-action'));
    assert.ok(traces.includes('Authentication response: host=login.um.edu.mo route=required-action status=400'));
    assert.ok(traces.includes('Authentication navigation failed: host=login.um.edu.mo route=required-action code=ERR_CONNECTION_RESET'));
    assert.ok(!traces.some(message => message.includes(secret) || message.includes('private-realm')));
});