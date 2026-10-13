const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { CookieJar } = require('tough-cookie');
const { browserLogin } = require('../browser-auth');
const { ORIGIN } = require('../auth');
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
for (const mode of ['button', 'Enter', 'Duo device confirmation', 'Duo Chinese device confirmation', 'Duo Chinese link confirmation', 'Duo lookalike host', 'Duo incomplete confirmation']) test(`MFA callback is not bounded by the submit action timeout (${mode})`, async () => {
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
        if (blocked) await assert.rejects(login, { name: 'AbortError' });
        else await login;
        assert.equal(submissions, 1);
        assert.equal(remembered, duo && !blocked ? 1 : 0);
        assert.equal(traces.includes('Duo device confirmation detected; remembering this device'), duo && !blocked);
        assert.equal(traces.includes('Browser session verified'), !blocked);
    } finally { approve(); await browser.close(); }
});