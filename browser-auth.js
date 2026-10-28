const { setTimeout: delay } = require('node:timers/promises');
const { fork } = require('node:child_process');
const { Cookie, Session, ORIGIN } = require('./auth');

function retryableSessionFailure(error) {
    if (error.retryAfterMs > 10000) return false;
    return error.code === 'SESSION_UNAVAILABLE' ? [502, 503, 504].includes(error.status) :
        ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code || error.code);
}

async function checkBrowserSession(session, signal, trace) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    for (let attempt = 0; ; attempt++) {
        bounded.throwIfAborted();
        try {
            const valid = await session.valid(bounded);
            bounded.throwIfAborted();
            return valid;
        } catch (error) {
            bounded.throwIfAborted();
            if (!retryableSessionFailure(error) || attempt >= 2) throw error;
            const milliseconds = Math.max(1000 * 2 ** attempt, error.retryAfterMs || 0);
            trace(`Session check temporarily unavailable; retry ${attempt + 1}/2 in ${milliseconds}ms`);
            await delay(milliseconds, undefined, { signal: bounded });
        }
    }
}

function isolatedBrowserLogin(session, credentials, bounded, signal, trace, keepOpen, headless) {
    return new Promise((resolve, reject) => {
        const child = fork(__filename, [], { execArgv: [], windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let verified = false, returned = false, failure, closing = false;
        let importing = Promise.resolve(), resolveExit;
        const exited = new Promise(resolve => { resolveExit = resolve; });
        const close = () => {
            if (!closing && child.connected) { closing = true; child.send({ type: 'abort' }, () => {}); }
            return exited;
        };
        const release = () => { bounded.removeEventListener('abort', close); signal?.removeEventListener('abort', close); };
        bounded.addEventListener('abort', close, { once: true });
        child.on('message', message => {
            if (message.type === 'trace') trace(message.value);
            if (message.type === 'error') failure = Object.assign(new Error(message.message), { name: message.name, code: message.code, status: message.status, retryAfterMs: message.retryAfterMs, retryAuthentication: message.retryAuthentication });
            if (message.type === 'verified') {
                importing = (async () => {
                    bounded.throwIfAborted();
                    for (const cookie of message.cookies) await session.jar.setCookie(Cookie.fromJSON(cookie), ORIGIN);
                    bounded.throwIfAborted();
                    verified = true;
                    if (keepOpen) {
                        bounded.removeEventListener('abort', close);
                        signal.addEventListener('abort', close, { once: true });
                        if (signal.aborted) { await close(); signal.throwIfAborted(); }
                        returned = true;
                        resolve(close);
                    }
                })().catch(error => { failure = error; void close(); });
            }
        });
        child.on('error', error => { failure = error; });
        child.once('close', async code => {
            release();
            resolveExit();
            await importing;
            if (returned) return;
            if (bounded.aborted) reject(bounded.reason);
            else if (failure) reject(failure);
            else if (verified && code === 0) resolve();
            else reject(new Error('Browser authentication process exited before verification'));
        });
        child.send({ kind: 'genai-browser-login', saved: JSON.stringify(session.jar.toJSON()), credentials, keepOpen, headless }, error => {
            if (error) { failure = error; child.kill(); }
        });
        if (bounded.aborted) void close();
    });
}

function authenticationLocation(url) {
    const location = new URL(url);
    const path = location.pathname;
    const action = /\/login-actions\/(authenticate|required-action|consent|first-broker-login|reset-credentials)(?:\/|$)/.exec(path)?.[1];
    const route = action || (path === '/oauth/oidc/callback' ? 'oidc-callback' : path === '/oauth/oidc/login' ? 'oidc-login' : /\/broker\/[^/]+\/endpoint\/?$/.test(path) ? 'broker-callback' : path.startsWith('/adfs/') ? 'umpass' : /\/protocol\/saml\/?$/.test(path) ? 'saml' : /\/error\/?$/.test(path) ? 'error' : path === '/' ? 'root' : 'other');
    return `host=${location.hostname || 'none'} route=${route}`;
}

async function browserLogin(session, credentials, signal, trace = () => {}, launcher, keepOpen = false, headless = true, { force = false, recoverSession = false } = {}) {
    if (keepOpen && !signal) throw new Error('Diagnostic browser requires disconnect signal');
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]);
    bounded.throwIfAborted();
    trace('Checking saved session');
    if (!keepOpen && !force) {
        try {
            if (await checkBrowserSession(session, bounded, trace)) return;
        } catch (error) {
            bounded.throwIfAborted();
            if (!recoverSession || !retryableSessionFailure(error)) throw error;
            trace('Saved session check unavailable; opening GENAI home for explicit reconnect');
            if (error.retryAfterMs > 0) await delay(error.retryAfterMs, undefined, { signal: bounded });
        }
    }
    bounded.throwIfAborted();
    if (!launcher) return isolatedBrowserLogin(session, credentials, bounded, signal, trace, keepOpen, headless);
    launcher ??= require('playwright-core').chromium;
    let browser;
    let retained = false;
    let closing;
    let phase = 'launch';
    let submitted = false;
    const release = () => signal?.removeEventListener('abort', close);
    const close = () => { release(); return closing ??= browser?.close().catch(() => {}); };
    bounded.addEventListener('abort', close, { once: true });
    try {
        trace(headless ? 'Starting temporary headless Edge' : 'Starting temporary visible Edge (diagnostic)');
        browser = await launcher.launch({ channel: 'msedge', headless, timeout: 30000 });
        bounded.throwIfAborted();
        const context = await browser.newContext();
        const page = await context.newPage();
        let inspectAt = Date.now() + 10000;
        let navigationFailure;
        page.on('framenavigated', frame => {
            if (frame !== page.mainFrame()) return;
            inspectAt = Date.now() + 10000;
            trace(`Authentication navigation: ${authenticationLocation(frame.url())}`);
        });
        page.on('response', response => {
            if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
            trace(`Authentication response: ${authenticationLocation(response.url())} status=${response.status()}`);
            navigationFailure = undefined;
            if (new URL(response.url()).origin === ORIGIN && response.status() >= 400) {
                const retryAfter = response.headers()['retry-after'];
                const milliseconds = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
                navigationFailure = Object.assign(new Error('GENAI login page unavailable'), {
                    code: 'SESSION_UNAVAILABLE', status: response.status(),
                    retryAfterMs: Number.isFinite(milliseconds) ? Math.min(Math.max(0, milliseconds), 86400000) : 0
                });
            }
        });
        page.on('requestfailed', request => {
            if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
            const code = /\b(ERR_[A-Z0-9_]+)\b/.exec(request.failure()?.errorText || '')?.[1] || 'UNKNOWN';
            trace(`Authentication navigation failed: ${authenticationLocation(request.url())} code=${code}`);
        });
        phase = 'webui-entry';
        trace('Opening GENAI home page');
        await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        let signInStarted = false;
        let entryRetries = 0;
        let duoDeviceConfirmationHandled = false;
        let lastStage;
        while (true) {
            bounded.throwIfAborted();
            if (navigationFailure) {
                const error = navigationFailure;
                if (submitted || ![502, 503, 504].includes(error.status) || entryRetries >= 2 || error.retryAfterMs > 10000) throw error;
                const milliseconds = Math.max(1000 * 2 ** entryRetries, error.retryAfterMs);
                entryRetries++;
                phase = 'webui-entry';
                trace(`GENAI login page returned HTTP ${error.status}; retry ${entryRetries}/2 in ${milliseconds}ms`);
                await delay(milliseconds, undefined, { signal: bounded });
                bounded.throwIfAborted();
                navigationFailure = undefined;
                signInStarted = false;
                await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
                continue;
            }
            const origin = new URL(page.url()).origin;
            const duo = /^https:\/\/api-[0-9a-f]{8}\.duosecurity\.com$/.test(origin);
            const entry = origin === ORIGIN && !submitted && !signInStarted;
            const stage = duo ? 'Waiting for Duo MFA / browser confirmation' : origin === 'https://websso.um.edu.mo' ? 'Waiting for UMPASS / MFA' : entry ? 'Waiting for GENAI sign-in page' : origin === ORIGIN ? 'Checking GENAI callback' : 'Waiting for identity redirect';
            if (stage !== lastStage) {
                trace(stage); lastStage = stage;
                phase = duo ? 'duo-mfa' : entry ? 'webui-entry' : origin === ORIGIN ? 'genai-callback' : origin === 'https://websso.um.edu.mo' ? (submitted ? 'mfa' : 'umpass') : 'identity-callback';
            }
            const password = page.locator('input[name="Password"][type="password"]');
            if (submitted && origin === 'https://websso.um.edu.mo' && await password.isVisible() &&
                await page.locator('#errorText, #error, .alert-error, .alert-danger').filter({ visible: true }).count()) {
                throw Object.assign(new Error('UMPASS rejected credentials'), { code: 'CREDENTIALS_REJECTED' });
            }
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
                const cookies = await context.cookies(ORIGIN);
                for (const cookie of cookies) {
                    await session.jar.setCookie(new Cookie({ key: cookie.name, value: cookie.value, domain: cookie.domain.replace(/^\./, ''), hostOnly: !cookie.domain.startsWith('.'), path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite.toLowerCase(), expires: cookie.expires > 0 ? new Date(cookie.expires * 1000) : 'Infinity' }), ORIGIN);
                }
                const hasToken = cookies.some(cookie => cookie.name === 'token' && cookie.value);
                if (hasToken) phase = 'verify-session';
                if (hasToken && await checkBrowserSession(session, bounded, trace)) {
                    bounded.throwIfAborted();
                    trace('Browser session verified');
                    if (keepOpen) {
                        retained = true;
                        signal.addEventListener('abort', close, { once: true });
                        browser.once?.('disconnected', () => {
                            release();
                            if (require.main === module && process.connected) process.disconnect();
                        });
                        trace('Diagnostic mode: Edge retained until Disconnect');
                        return close;
                    }
                    return;
                }
                if (!submitted && !signInStarted && /^\/(?:auth\/?)?$/.test(new URL(page.url()).pathname)) {
                    const signIn = page.getByRole('button', { name: /^(?:Continue with UMPASS|\u4f7f\u7528 UMPASS \u7ee7\u7eed|\u4f7f\u7528 UMPASS \u7e7c\u7e8c)$/ });
                    if (await signIn.isVisible()) {
                        signInStarted = true;
                        phase = 'identity-redirect';
                        trace('Starting UMPASS from GENAI sign-in page');
                        await signIn.click({ noWaitAfter: true });
                    }
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
        const navigationCode = /\b(ERR_[A-Z0-9_]+)\b/.exec(error?.message || '')?.[1];
        if (navigationCode) error.code = navigationCode;
        else if (/^[A-Z0-9_]+$/.test(error.cause?.code || '')) error.code = error.cause.code;
        error.retryAuthentication = !submitted && !bounded.aborted;
        const code = bounded.aborted ? bounded.reason?.name : error?.name;
        trace(`Browser login failed: phase=${phase} code=${typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : 'UNKNOWN'}`);
        throw error;
    } finally {
        bounded.removeEventListener('abort', close);
        if (browser && !retained) { await close(); trace('Temporary Edge closed'); }
    }
}

if (require.main === module && typeof process.send === 'function') process.once('message', options => {
    if (options?.kind !== 'genai-browser-login') return;
    const controller = new AbortController();
    let retained;
    const finish = () => { if (process.connected) process.disconnect(); };
    const send = message => { if (process.connected) process.send(message, () => {}); };
    const abort = () => {
        controller.abort();
        if (retained) void retained().finally(finish);
    };
    process.on('disconnect', abort);
    process.on('message', message => {
        if (message.type !== 'abort') return;
        abort();
    });
    void (async () => {
        const session = new Session(options.saved);
        const imported = new Map();
        const setCookie = session.jar.setCookie.bind(session.jar);
        session.jar.setCookie = async (...args) => {
            const cookie = await setCookie(...args);
            imported.set(JSON.stringify([cookie.domain, cookie.path, cookie.key]), cookie.toJSON());
            return cookie;
        };
        try {
            retained = await browserLogin(session, options.credentials, controller.signal,
                value => send({ type: 'trace', value }), require('playwright-core').chromium, options.keepOpen, options.headless, { force: true });
            send({ type: 'verified', cookies: [...imported.values()] });
            if (!retained || controller.signal.aborted) { await retained?.(); finish(); }
        } catch (error) {
            send({ type: 'error', name: error.name, code: error.code, message: error.message, status: error.status, retryAfterMs: error.retryAfterMs, retryAuthentication: error.retryAuthentication });
            finish();
        }
    })();
});
module.exports = { browserLogin };