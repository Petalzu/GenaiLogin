const { chromium } = require('playwright-core');
const { Cookie } = require('tough-cookie');
const { setTimeout: delay } = require('node:timers/promises');
const { ORIGIN } = require('./auth');

function authenticationLocation(url) {
    const location = new URL(url);
    const path = location.pathname;
    const action = /\/login-actions\/(authenticate|required-action|consent|first-broker-login|reset-credentials)(?:\/|$)/.exec(path)?.[1];
    const route = action || (path === '/oauth/oidc/callback' ? 'oidc-callback' : path === '/oauth/oidc/login' ? 'oidc-login' : /\/broker\/[^/]+\/endpoint\/?$/.test(path) ? 'broker-callback' : path.startsWith('/adfs/') ? 'umpass' : /\/protocol\/saml\/?$/.test(path) ? 'saml' : /\/error\/?$/.test(path) ? 'error' : path === '/' ? 'root' : 'other');
    return `host=${location.hostname || 'none'} route=${route}`;
}

async function browserLogin(session, credentials, signal, trace = () => {}, launcher = chromium, keepOpen = false, headless = true) {
    if (keepOpen && !signal) throw new Error('Diagnostic browser requires disconnect signal');
    trace('Checking saved session');
    if (!keepOpen && await session.valid(signal)) return;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]);
    bounded.throwIfAborted();
    let browser;
    let retained = false;
    let phase = 'launch';
    const close = () => { browser?.close().catch(() => {}); };
    bounded.addEventListener('abort', close, { once: true });
    try {
        trace(headless ? 'Starting temporary headless Edge' : 'Starting temporary visible Edge (diagnostic)');
        browser = await launcher.launch({ channel: 'msedge', headless, timeout: 30000 });
        bounded.throwIfAborted();
        const context = await browser.newContext();
        const page = await context.newPage();
        let inspectAt = Date.now() + 10000;
        page.on('framenavigated', frame => {
            if (frame !== page.mainFrame()) return;
            inspectAt = Date.now() + 10000;
            trace(`Authentication navigation: ${authenticationLocation(frame.url())}`);
        });
        page.on('response', response => {
            if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
            trace(`Authentication response: ${authenticationLocation(response.url())} status=${response.status()}`);
        });
        page.on('requestfailed', request => {
            if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
            const code = /\b(ERR_[A-Z0-9_]+)\b/.exec(request.failure()?.errorText || '')?.[1] || 'UNKNOWN';
            trace(`Authentication navigation failed: ${authenticationLocation(request.url())} code=${code}`);
        });
        phase = 'identity-redirect';
        await page.goto(`${ORIGIN}/oauth/oidc/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        let submitted = false;
        let duoDeviceConfirmationHandled = false;
        let lastStage;
        while (true) {
            bounded.throwIfAborted();
            const origin = new URL(page.url()).origin;
            const duo = /^https:\/\/api-[0-9a-f]{8}\.duosecurity\.com$/.test(origin);
            const stage = duo ? 'Waiting for Duo MFA / browser confirmation' : origin === 'https://websso.um.edu.mo' ? 'Waiting for UMPASS / MFA' : origin === ORIGIN ? 'Checking GENAI callback' : 'Waiting for identity redirect';
            if (stage !== lastStage) {
                trace(stage); lastStage = stage;
                phase = duo ? 'duo-mfa' : origin === ORIGIN ? 'genai-callback' : origin === 'https://websso.um.edu.mo' ? (submitted ? 'mfa' : 'umpass') : 'identity-callback';
            }
            const password = page.locator('input[name="Password"][type="password"]');
            if (!submitted && origin === 'https://websso.um.edu.mo' && await password.isVisible()) {
                phase = 'verify-form';
                const safe = await password.evaluate(input => {
                    const form = input.form;
                    return globalThis.location.origin === 'https://websso.um.edu.mo' && form && new URL(form.action, globalThis.location.href).origin === globalThis.location.origin && form.method.toLowerCase() === 'post';
                });
                if (!safe) throw new Error('Unexpected credential form');
                phase = 'fill-credentials';
                trace('Filling verified UMPASS login form');
                const form = page.locator('form').filter({ has: password });
                await form.locator('input[name="UserName"]:visible').fill(credentials.username);
                await password.fill(credentials.password);
                submitted = true;
                phase = 'submit-credentials';
                trace('Submitting credentials once; waiting for automatic MFA completion');
                const submit = page.locator('#submitButton');
                if (await submit.count()) await submit.click({ noWaitAfter: true });
                else await password.press('Enter', { noWaitAfter: true });
                phase = 'mfa-redirect';
                trace('Credentials submitted; waiting for MFA / redirect');
            }
            if (submitted && duo && !duoDeviceConfirmationHandled) {
                const rememberName = /^(?:Yes, this is my device|\u662f\uff0c\u8fd9\u662f\u6211\u7684\u8bbe\u5907)$/;
                const declineName = /^(?:No, other people use this device|\u4e0d\u662f\uff0c\u5176\u4ed6\u4eba\u4f1a\u4f7f\u7528\u6b64\u8bbe\u5907)$/;
                const remember = page.getByRole('button', { name: rememberName });
                const decline = page.getByRole('button', { name: declineName }).or(page.getByRole('link', { name: declineName }));
                if (await remember.isVisible() && await decline.isVisible()) {
                    duoDeviceConfirmationHandled = true;
                    phase = 'duo-device-confirmation';
                    trace('Duo device confirmation detected; remembering this device');
                    await remember.click({ noWaitAfter: true });
                    phase = 'duo-redirect';
                    trace('Duo device confirmation completed; waiting for identity callback');
                }
            }
            if (origin === ORIGIN) {
                phase = 'verify-session';
                const cookies = await context.cookies(ORIGIN);
                for (const cookie of cookies) {
                    await session.jar.setCookie(new Cookie({ key: cookie.name, value: cookie.value, domain: cookie.domain.replace(/^\./, ''), hostOnly: !cookie.domain.startsWith('.'), path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite.toLowerCase(), expires: cookie.expires > 0 ? new Date(cookie.expires * 1000) : 'Infinity' }), ORIGIN);
                }
                if (cookies.length && await session.valid(bounded)) {
                    bounded.throwIfAborted();
                    trace('Browser session verified');
                    if (keepOpen) {
                        retained = true;
                        signal.addEventListener('abort', close, { once: true });
                        browser.once?.('disconnected', () => signal.removeEventListener('abort', close));
                        trace('Diagnostic mode: Edge retained until Disconnect');
                    }
                    return;
                }
            }
            if (Date.now() >= inspectAt) {
                inspectAt = Date.now() + 15000;
                const state = await page.evaluate(() => {
                    const visible = element => !!element.getClientRects().length;
                    const inputs = Array.from(globalThis.document.querySelectorAll('input'));
                    return {
                        ready: globalThis.document.readyState,
                        forms: globalThis.document.forms.length,
                        federationForms: Array.from(globalThis.document.forms).filter(form => Array.from(form.elements).some(element => ['SAMLRequest', 'SAMLResponse', 'wresult'].includes(element.name))).length,
                        password: inputs.some(input => input.type === 'password' && visible(input)),
                        otp: inputs.some(input => /otp|totp|verificationcode|authcode/i.test(input.name + input.id) && visible(input)),
                        buttons: Array.from(globalThis.document.querySelectorAll('button,input[type="submit"]')).filter(visible).length,
                        error: Array.from(globalThis.document.querySelectorAll('#error,#errorText,.alert-error,.alert-danger')).some(visible)
                    };
                }).catch(() => null);
                if (state) trace(`Authentication waiting: ${authenticationLocation(page.url())} state=${JSON.stringify(state)}`);
            }
            await delay(1000, undefined, { signal: bounded });
        }
    } catch (error) {
        const code = bounded.aborted ? bounded.reason?.name : error?.name;
        trace(`Browser login failed: phase=${phase} code=${typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : 'UNKNOWN'}`);
        throw error;
    } finally {
        bounded.removeEventListener('abort', close);
        if (browser && !retained) { await browser.close(); trace('Temporary Edge closed'); }
    }
}
module.exports = { browserLogin };