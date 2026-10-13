const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserLogin } = require('../browser-auth');
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
test('browser closes on navigation failure', async () => {
    let closed = false;
    const traces = [];
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => ({ on: () => {}, goto: async () => { throw new Error('navigation failed'); } }) }) };
    await assert.rejects(browserLogin({ valid: async () => false }, {}, undefined, message => traces.push(message), { launch: async () => browser }), /navigation failed/);
    assert.ok(closed);
    assert.ok(traces.includes('Browser login failed: phase=identity-redirect code=Error'));
    assert.ok(!traces.some(message => message.includes('navigation failed')));
});
test('verified cookies survive browser closure', async () => {
    let checks = 0; let closed = false; let imported;
    const page = { on: () => {}, goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => page, cookies: async () => [{ name: 'token', value: 'test', domain: 'chat.genai.um.edu.mo', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => ++checks > 1, jar: { setCookie: async cookie => { imported = cookie; } } }, {}, undefined, () => {}, { launch: async () => browser });
    assert.equal(imported.value, 'test'); assert.ok(closed);
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