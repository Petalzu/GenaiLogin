const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { CookieJar } = require('tough-cookie');
const { browserLogin } = require('../browser-auth');
const { ORIGIN } = require('../auth');
const { dashboardHtml } = require('../dashboard');
test('ADFS duplicate username fields only fill visible password form', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<form><input name="UserName" type="email"><input name="Password" type="password"></form><form><input name="UserName" type="hidden" value="unchanged"></form>');
        const password = page.locator('input[name="Password"][type="password"]');
        await assert.rejects(page.locator('input[name="UserName"]').fill('test'), /strict mode violation/);
        const form = page.locator('form').filter({ has: password });
        await form.locator('input[name="UserName"]:visible').fill('test');
        assert.equal(await page.locator('input[type="email"]').inputValue(), 'test');
        assert.equal(await page.locator('input[type="hidden"]').inputValue(), 'unchanged');
    } finally { await browser.close(); }
});
test('browser login starts at the WebUI home and recovers a temporarily unavailable entry', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const jar = new CookieJar();
    const visits = [];
    const traces = [];
    let homeRequests = 0;
    let loginRequests = 0;
    let verified = 0;
    try {
        const context = await browser.newContext();
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            visits.push(url.pathname);
            if (url.origin !== ORIGIN) return route.fulfill({ status: 404 });
            if (url.pathname === '/') {
                homeRequests++;
                if (homeRequests === 1) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'no healthy upstream' });
                return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>location.href="/auth?redirect=%2F"</script>' });
            }
            if (url.pathname === '/auth') return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'set-cookie': 'routing=not-a-login; Path=/; Secure' },
                body: '<button onclick="location.href=\'/oauth/oidc/login\'">Continue with UMPASS</button>' });
            if (url.pathname === '/oauth/oidc/login') {
                loginRequests++;
                if (homeRequests < 2 || loginRequests === 1) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'no healthy upstream' });
                return route.fulfill({ contentType: 'text/html', headers: { 'set-cookie': 'token=fresh; Path=/; Secure; HttpOnly' },
                    body: '<script>location.href="/"</script>' });
            }
            return route.fulfill({ status: 404 });
        });
        await browserLogin({ jar, valid: async () => {
            verified++;
            assert.equal((await jar.getCookies(ORIGIN)).some(cookie => cookie.key === 'token' && cookie.value === 'fresh'), true);
            return true;
        } }, {}, AbortSignal.timeout(15000), message => traces.push(message),
        { launch: async () => ({ newContext: async () => context, close: () => browser.close() }) }, false, true, { force: true });
        assert.equal(visits[0], '/');
        assert.equal(loginRequests, 2);
        assert.equal(verified, 1);
        assert.ok(traces.includes('Browser session verified'));
        assert.ok(!traces.some(message => message.includes('no healthy upstream')));
    } finally { await browser.close(); }
});
test('unavailable home pages stop after bounded retries without validating a session or submitting credentials', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const scenario of [{ status: 503, attempts: 3 }, { status: 403, attempts: 1 }, { status: 429, attempts: 1 },
            { status: 503, attempts: 1, retryAfter: '60' }, { status: 503, attempts: 1, cancel: true }]) {
            const context = await browser.newContext();
            const controller = new AbortController();
            let requests = 0;
            await context.route('**/*', route => {
                assert.equal(new URL(route.request().url()).pathname, '/');
                assert.equal(route.request().method(), 'GET');
                requests++;
                return route.fulfill({ status: scenario.status, contentType: 'text/plain', body: 'no healthy upstream',
                    headers: scenario.retryAfter ? { 'retry-after': scenario.retryAfter } : {} });
            });
            await assert.rejects(browserLogin({ jar: new CookieJar(), valid: () => assert.fail('error pages are not authenticated callbacks') }, {},
                AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), message => { if (scenario.cancel && message.includes('retry')) controller.abort(); },
                { launch: async () => ({ newContext: async () => context, close: () => context.close() }) }, false, true, { force: true }),
            scenario.cancel ? { name: 'AbortError' } : { code: 'SESSION_UNAVAILABLE', status: scenario.status });
            assert.equal(requests, scenario.attempts);
        }
    } finally { await browser.close(); }
});
for (const mode of ['button', 'Enter', 'callback unavailable', 'Duo device confirmation', 'Duo Chinese device confirmation', 'Duo Chinese link confirmation', 'Duo lookalike host', 'Duo incomplete confirmation']) test(`MFA callback is not bounded by the submit action timeout (${mode})`, async () => {
    const submitButton = mode !== 'Enter';
    const duo = mode.startsWith('Duo');
    const chinese = mode.startsWith('Duo Chinese');
    const blocked = mode === 'Duo lookalike host' || mode === 'Duo incomplete confirmation';
    const duoOrigin = mode === 'Duo lookalike host' ? 'https://api-46ba0059.duosecurity.com.invalid' : 'https://api-46ba0059.duosecurity.com';
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    let approve;
    const approval = new Promise(resolve => { approve = resolve; });
    let submissions = 0;
    let remembered = 0;
    const traces = [];
    const jar = new CookieJar();
    try {
        const context = await browser.newContext();
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === ORIGIN && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<script>location.href="/auth?redirect=%2F"</script>' });
            if (url.origin === ORIGIN && url.pathname === '/auth') {
                const label = chinese ? '\u4f7f\u7528 UMPASS \u7ee7\u7eed' : 'Continue with UMPASS';
                return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button onclick="location.href='/oauth/oidc/login'">${label}</button>` });
            }
            if (url.origin === ORIGIN && url.pathname === '/oauth/oidc/login') {
                return route.fulfill({ contentType: 'text/html', body: '<script>location.href="https://websso.um.edu.mo/adfs/ls/"</script>' });
            }
            if (url.origin === 'https://websso.um.edu.mo') {
                if (route.request().method() === 'POST') {
                    submissions++;
                    await approval;
                    const destination = duo ? `${duoOrigin}/remember` : `${ORIGIN}/oauth/oidc/callback`;
                    return route.fulfill({ contentType: 'text/html', body: `<script>location.href="${destination}"</script>` });
                }
                return route.fulfill({ contentType: 'text/html', body: `<form method="post"><input name="UserName"><input name="Password" type="password"><button${submitButton ? ' id="submitButton"' : ''} type="submit">Sign in</button></form>` });
            }
            if (url.origin === duoOrigin) {
                if (url.pathname === '/trust') {
                    remembered++;
                    return route.fulfill({ contentType: 'text/html', body: `<script>location.href="${ORIGIN}/oauth/oidc/callback"</script>` });
                }
                if (url.pathname === '/remember') {
                    const rememberText = chinese ? '\u662f\uff0c\u8fd9\u662f\u6211\u7684\u8bbe\u5907' : 'Yes, this is my device';
                    const declineText = chinese ? '\u4e0d\u662f\uff0c\u5176\u4ed6\u4eba\u4f1a\u4f7f\u7528\u6b64\u8bbe\u5907' : 'No, other people use this device';
                    const remember = `<button onclick="location.href='/trust'">${rememberText}</button>`;
                    const decline = mode === 'Duo incomplete confirmation' ? '' : mode === 'Duo Chinese link confirmation' ? `<a href="/decline">${declineText}</a>` : `<button onclick="location.href='/decline'">${declineText}</button>`;
                    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: remember + decline });
                }
                assert.fail('must not decline remembering the Duo device');
            }
            if (url.origin === ORIGIN && url.pathname === '/oauth/oidc/callback') {
                if (mode === 'callback unavailable') return route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' });
                return route.fulfill({ contentType: 'text/html', headers: { 'set-cookie': 'token=test; Path=/; Secure; HttpOnly; SameSite=Lax' }, body: '<p>Signed in</p>' });
            }
            return route.fulfill({ status: 404 });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(1000);
        const session = { jar, valid: async () => (await jar.getCookieString(ORIGIN)).includes('token=test') };
        const login = browserLogin(session, { username: 'test', password: 'test-password' }, AbortSignal.timeout(10000), message => {
            traces.push(message);
            if (message === 'Credentials submitted; waiting for MFA / redirect') approve();
        }, { launch: async () => ({ newContext: async () => ({ newPage: async () => page, cookies: url => context.cookies(url) }), close: () => browser.close() }) }).catch(error => {
            error.message += `; submissions=${submissions}; stages=${JSON.stringify(traces)}`;
            throw error;
        });
        if (mode === 'callback unavailable') await assert.rejects(login, { code: 'SESSION_UNAVAILABLE', status: 503, retryAuthentication: false });
        else if (blocked) await assert.rejects(login, { name: 'AbortError' });
        else await login;
        assert.equal(submissions, 1);
        assert.equal(remembered, duo && !blocked ? 1 : 0);
        assert.equal(traces.includes('Duo device confirmation detected; remembering this device'), duo && !blocked);
        assert.equal(traces.includes('Browser session verified'), !blocked && mode !== 'callback unavailable');
    } finally { approve(); await browser.close(); }
});

test('Dashboard states and controls remain usable on narrow and wide views', { timeout: 20000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const context = await browser.newContext();
        await context.addInitScript(() => {
            globalThis.dashboardCommands = [];
            globalThis.acquireVsCodeApi = () => ({ postMessage: message => globalThis.dashboardCommands.push(message.command) });
            globalThis.dashboardTimers = new Set();
            const schedule = globalThis.setInterval.bind(globalThis);
            const cancel = globalThis.clearInterval.bind(globalThis);
            globalThis.setInterval = (callback, milliseconds, ...args) => {
                const timer = schedule(callback, milliseconds, ...args);
                if (milliseconds === 1000) globalThis.dashboardTimers.add(timer);
                return timer;
            };
            globalThis.clearInterval = timer => { globalThis.dashboardTimers.delete(timer); cancel(timer); };
        });
        await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: dashboardHtml({
            status: 'Disconnected', connection: 'disconnected', active: false, listening: false,
            port: 58379, models: [], keepalive: { state: 'idle' }
        }) }));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://genai-dashboard.test/');
        await page.waitForFunction(() => globalThis.dashboardCommands.includes('ready'));
        assert.equal(await page.title(), 'GENAI Login');
        assert.match(await page.locator('h1').textContent(), /^GENAI Login/);
        const render = state => page.evaluate(data => globalThis.dispatchEvent(new MessageEvent('message', { data: { type: 'state', data } })), state);
        const base = { port: 58379, models: [], keepalive: { state: 'idle' } };
        assert.equal(await page.locator('#status-dot').getAttribute('class'), 'status-dot ');
        assert.equal(await page.locator('[data-command="connect"]').isEnabled(), true);
        assert.equal(await page.locator('[data-command="disconnect"]').isEnabled(), false);
        assert.equal(await page.evaluate(() => globalThis.dashboardTimers.size), 0);
        const unchanged = await page.evaluate(data => {
            const ids = ['model-list', 'token-breakdown', 'cost-breakdown', 'history-breakdown'];
            const nodes = ids.map(id => document.getElementById(id).firstChild);
            globalThis.dispatchEvent(new MessageEvent('message', { data: { type: 'state', data } }));
            return ids.every((id, index) => document.getElementById(id).firstChild === nodes[index]);
        }, { ...base, connection: 'disconnected', status: 'Disconnected', active: false });
        assert.equal(unchanged, true);
        await render({ ...base, connection: 'disconnected', status: 'Disconnected', active: false,
            models: [{ name: 'changed-model', requests: 2 }], modelUsage: [{ name: 'changed-model', tokensIn: 10, inputUsageReports: 1 }],
            history: { requests: 2, tokensIn: 10, inputUsageReports: 1, modelUsage: [{ name: 'changed-model', tokensIn: 10, inputUsageReports: 1 }] } });
        assert.match(await page.locator('#model-list').textContent(), /changed-model/);
        for (const id of ['token-breakdown', 'cost-breakdown', 'history-breakdown']) assert.match(await page.locator('#' + id).textContent(), /changed-model/);
        for (const width of [240, 360, 1200]) {
            await page.setViewportSize({ width, height: 900 });
            await render({ ...base, connection: 'disconnected', status: 'Disconnected', active: false, listening: true });
            assert.equal(await page.locator('#status-text').textContent(), '待命');
            assert.equal(await page.locator('[data-command="disconnect"]').isEnabled(), true);
            assert.equal(await page.locator('[data-command="connect"]').isEnabled(), true);
            assert.equal(await page.locator('[data-command="credentials"]').isEnabled(), true);
            assert.equal(await page.locator('[data-command="mcp"]').isEnabled(), true);
            const drawingLabel = page.locator('[data-command="mcp"] strong');
            assert.equal(await drawingLabel.textContent(), '添加绘画 MCP');
            assert.equal(await drawingLabel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
            assert.equal(await page.locator('#port-badge').textContent(), ':58379');
            await render({ ...base, connection: 'authenticating', status: 'Authenticating', active: true,
                listening: true, loginPhase: 'mfa', pendingActions: ['connect'] });
            assert.equal(await page.locator('#status-text').textContent(), '正在登录');
            assert.equal(await page.locator('#keepalive-text').textContent(), '等待手机 MFA 确认');
            assert.equal(await page.locator('[data-command="connect"]').isEnabled(), false);
            assert.equal(await page.locator('[data-command="disconnect"]').isEnabled(), true);
            assert.equal(await page.locator('#port-badge').textContent(), ':58379');
            await render({ ...base, connection: 'authenticating', status: 'Authenticating', active: true,
                listening: true, loginPhase: 'webui-entry', pendingActions: ['connect'] });
            assert.equal(await page.locator('#keepalive-text').textContent(), '正在打开 GENAI 登录页');
            await render({ ...base, connection: 'connected', status: 'Connected :58379', active: true,
                connectedAt: Date.now(), listening: true, sessionPersistence: 'error',
                keepalive: { state: 'error', lastCheckAt: Date.now(), nextCheckAt: Date.now() + 120000 } });
            assert.match(await page.locator('#keepalive-text').textContent(), /保活暂时失败.*重试/);
            assert.equal(await page.locator('[data-command="connect"]').isEnabled(), true);
            assert.equal(await page.locator('#connect-label').textContent(), '重新连接');
            assert.equal(await page.locator('#session-warning').isVisible(), true);
            assert.equal(await page.locator('#status-dot').getAttribute('class'), 'status-dot warning');
            assert.equal(await page.evaluate(() => globalThis.dashboardTimers.size), 1);
            assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
            await render({ ...base, connection: 'error', status: 'Connection interrupted; retrying', active: true, listening: true,
                keepalive: { state: 'retrying', nextCheckAt: Date.now() + 60000 } });
            assert.match(await page.locator('#keepalive-text').textContent(), /重登暂时失败.*自动重试/);
            assert.equal(await page.locator('[data-command="connect"]').isEnabled(), true);
            await render({ ...base, connection: 'error', status: 'Authentication required; reconnect', active: true, listening: true,
                keepalive: { state: 'needs-login' } });
            assert.equal(await page.locator('#keepalive-text').textContent(), '验证未完成，请重新连接');
            assert.equal(await page.locator('[data-command="connect"]').isEnabled(), true);
            await page.locator('[data-command="connect"]').click();
            assert.equal(await page.evaluate(() => globalThis.dashboardCommands.at(-1)), 'connect');
            await render({ ...base, connection: 'connected', status: 'Connected :58379', active: true, listening: true,
                connectedAt: Date.now(), keepalive: { state: 'healthy', expiresAt: Date.now() + 45000, nextCheckAt: Date.now() + 10000 } });
            assert.equal(await page.locator('[data-command="connect"]').isEnabled(), false);
            assert.match(await page.locator('#keepalive-text').textContent(), /会话即将或已经到期/);
            assert.match(await page.locator('#last-check').textContent(), /下次检查/);
            assert.match(await page.locator('#last-check').getAttribute('title'), /会话到期/);
            assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
            await render({ ...base, connection: 'connected', status: 'Connected :58379 (shared window)', shared: true,
                active: true, listening: true, connectedAt: Date.now() });
            assert.equal(await page.locator('#status-text').textContent(), '已连接 · 其他窗口');
            assert.match(await page.locator('#keepalive-text').textContent(), /^只读/);
            for (const command of ['connect', 'diagnose', 'credentials', 'clear', 'disconnect']) assert.equal(await page.locator(`[data-command="${command}"]`).isEnabled(), false);
            assert.equal(await page.locator('[data-command="models"]').isEnabled(), true);
            assert.equal(await page.locator('[data-command="mcp"]').isEnabled(), true);
            if (process.env.GENAI_DASHBOARD_SCREENSHOTS) {
                const { join } = require('node:path');
                const { tmpdir } = require('node:os');
                await page.screenshot({ path: join(tmpdir(), `genai-dashboard-${width}.png`), fullPage: true });
            }
        }
        await render({ ...base, connection: 'disconnected', status: 'Disconnected', active: false });
        assert.equal(await page.evaluate(() => globalThis.dashboardTimers.size), 0);
        await page.locator('[data-command="mcp"]').click();
        assert.equal(await page.evaluate(() => globalThis.dashboardCommands.at(-1)), 'mcp');
        await render({ ...base, connection: 'disconnected', status: 'Disconnected', active: false, pendingActions: ['mcp'] });
        assert.equal(await page.locator('[data-command="mcp"]').isEnabled(), false);
        await render({ ...base, connection: 'disconnected', status: 'Disconnected', active: false });
        await page.locator('[data-command="connect"]').click();
        assert.equal(await page.evaluate(() => globalThis.dashboardCommands.at(-1)), 'connect');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('verified UMPASS rejection is reported without resubmitting credentials', { timeout: 15000 }, async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const traces = [];
    let submissions = 0;
    try {
        const context = await browser.newContext();
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin === ORIGIN) return route.fulfill({ contentType: 'text/html', body: '<script>location.href="https://websso.um.edu.mo/adfs/ls/"</script>' });
            if (url.origin === 'https://websso.um.edu.mo') {
                const rejected = route.request().method() === 'POST';
                if (rejected) submissions++;
                return route.fulfill({ contentType: 'text/html', body: `<form method="post"><input name="UserName"><input name="Password" type="password"><button id="submitButton" type="submit">Sign in</button></form>${rejected ? '<p id="errorText">Private account error</p>' : ''}` });
            }
            return route.fulfill({ status: 404 });
        });
        const page = await context.newPage();
        await assert.rejects(browserLogin({ valid: async () => false }, { username: 'test', password: 'dummy' }, AbortSignal.timeout(10000), message => traces.push(message),
            { launch: async () => ({ newContext: async () => context, close: () => browser.close() }) }), { code: 'CREDENTIALS_REJECTED' });
        assert.equal(submissions, 1);
        assert.ok(!traces.some(message => message.includes('Private account error') || message.includes('dummy')));
        assert.equal(page.isClosed(), true);
    } finally { await browser.close(); }
});