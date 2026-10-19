const { Cookie, CookieJar } = require('tough-cookie');
const ORIGIN = 'https://chat.genai.um.edu.mo';
const HOSTS = new Set(['chat.genai.um.edu.mo', 'login.um.edu.mo', 'websso.um.edu.mo']);
const sessionWrites = new WeakMap();

function createKeepaliveSchedule(session, now = Date.now) {
    let lastActivityAt = now(), lastCheckAt = now(), failures = 0, retryAt, cooldownAt = 0, activityVersion = 0;
    const snapshot = () => {
        const current = now();
        const expiresAt = session.expiresAt?.() ?? null;
        let nextCheckAt = retryAt ?? Math.min(lastActivityAt + 120000, lastCheckAt + 300000);
        if (expiresAt !== null && retryAt === undefined) {
            const deadline = expiresAt - 60000 > lastCheckAt ? expiresAt - 60000 : expiresAt;
            nextCheckAt = Math.min(nextCheckAt, Math.max(lastCheckAt + 30000, deadline));
        }
        return { nextCheckAt: Math.max(current, nextCheckAt, cooldownAt), expiresAt, lastActivityAt, activityVersion,
            expiring: expiresAt !== null && expiresAt - current <= 60000 };
    };
    return {
        activity(authenticated = true) {
            lastActivityAt = now();
            if (authenticated) { activityVersion++; failures = 0; retryAt = undefined; }
        },
        checked() { lastCheckAt = now(); lastActivityAt = now(); failures = 0; retryAt = undefined; cooldownAt = 0; },
        failed(retryAfterMs = 0) {
            failures++;
            lastCheckAt = now();
            const delay = Math.min(30000 * 2 ** Math.min(failures - 1, 4), 300000);
            cooldownAt = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? now() + retryAfterMs : 0;
            retryAt = now() + Math.max(delay, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
        },
        snapshot
    };
}

function createSessionPersistence(session, secrets, isCurrent, onState = () => {}, initiallySaved = false) {
    const fingerprint = snapshot => JSON.stringify({ ...snapshot, cookies: snapshot.cookies?.map(cookie => {
        const value = { ...cookie }; delete value.lastAccessed; return value;
    }) });
    let saved = initiallySaved ? fingerprint(session.jar.toJSON()) : undefined;
    let requested, pending;
    const save = () => {
        if (!isCurrent()) return Promise.resolve(false);
        const snapshot = session.jar.toJSON();
        const nextFingerprint = fingerprint(snapshot);
        if (nextFingerprint === saved && !pending) return Promise.resolve(true);
        const next = { fingerprint: nextFingerprint, value: JSON.stringify(snapshot) };
        requested = next;
        if (pending) return pending;
        const previous = sessionWrites.get(secrets) || Promise.resolve();
        pending = previous.catch(() => {}).then(async () => {
            while (requested && isCurrent()) {
                const value = requested; requested = undefined;
                if (value.fingerprint === saved) continue;
                try {
                    await secrets.store('session', value.value);
                    if (!isCurrent()) return false;
                    saved = value.fingerprint;
                    onState('saved');
                } catch {
                    requested = undefined;
                    if (isCurrent()) onState('error');
                    return false;
                }
            }
            return isCurrent();
        }).finally(() => { pending = undefined; });
        sessionWrites.set(secrets, pending);
        return pending;
    };
    return { save, flush: () => pending || Promise.resolve() };
}

class Session {
    constructor(saved, trace = () => {}) { this.jar = saved ? CookieJar.fromJSON(saved) : new CookieJar(); this.trace = trace; }
    expiresAt() {
        const token = this.jar.getCookiesSync(ORIGIN, { expire: false }).find(cookie => cookie.key === 'token');
        if (!token) return null;
        const deadlines = [];
        const cookieExpiry = token.expiryTime();
        if (Number.isFinite(cookieExpiry)) deadlines.push(cookieExpiry);
        if (token.value.length <= 16384) {
            try {
                const parts = token.value.split('.');
                const claims = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) : null;
                if (Number.isSafeInteger(claims?.exp) && claims.exp > 0 && claims.exp <= 8640000000000) deadlines.push(claims.exp * 1000);
            } catch {}
        }
        return deadlines.length ? Math.min(...deadlines) : null;
    }
    async request(url, options = {}) {
        let current = new URL(url);
        let method = options.method || 'GET';
        let body = options.body;
        for (let count = 0; count < 20; count++) {
            if (current.protocol !== 'https:' || !HOSTS.has(current.hostname)) throw new Error('Untrusted authentication destination');
            const headers = { ...options.headers, Cookie: await this.jar.getCookieString(current.href) };
            this.trace(`HTTP ${method} ${current.hostname}`);
            let response;
            try {
                response = await (options.fetch || fetch)(current, { method, body, headers, redirect: 'manual', signal: options.signal || AbortSignal.timeout(120000), ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}) });
            } catch (error) {
                const code = error.cause?.code || error.name;
                this.trace(`Transport failure: ${/^[A-Za-z0-9_]+$/.test(code) ? code : 'UNKNOWN'}`);
                throw error;
            }
            this.trace(`HTTP status ${response.status}`);
            for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, current.href);
            const location = response.headers.get('location');
            if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
            const next = new URL(location, current);
            if (options.checkSession && next.protocol === 'https:' && HOSTS.has(next.hostname) &&
                (next.origin !== ORIGIN || next.pathname === '/oauth/oidc/login')) return response;
            await response.body?.cancel();
            if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; }
            if (body && next.origin !== current.origin) throw new Error('Cross-origin POST redirect refused');
            current = next;
        }
        throw new Error('Too many authentication redirects');
    }
    async valid(signal) {
        const response = await this.request(`${ORIGIN}/api/v1/auths/`, { signal, checkSession: true });
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        await response.body?.cancel();
        if (response.ok && contentType.includes('application/json')) return true;
        if (response.status === 401) return false;
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
            const next = new URL(response.headers.get('location'), response.url || ORIGIN);
            if (next.protocol === 'https:' && HOSTS.has(next.hostname) &&
                (next.origin !== ORIGIN || next.pathname === '/oauth/oidc/login')) return false;
        }
        if (response.ok && contentType.includes('text/html') && response.url &&
            ['login.um.edu.mo', 'websso.um.edu.mo'].includes(new URL(response.url).hostname)) return false;
        throw Object.assign(new Error('Session check temporarily unavailable'), {
            code: 'SESSION_UNAVAILABLE', status: response.status,
            retryAfterMs: (() => {
                const value = response.headers.get('retry-after');
                if (!value) return 0;
                const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
                return Number.isFinite(milliseconds) ? Math.min(Math.max(0, milliseconds), 86400000) : 0;
            })()
        });
    }
}

function forms(html, url) {
    return require('./auth-forms').forms(html, url);
}
async function login(session, credentials, signal, trace = () => {}) {
    trace('Checking saved session');
    if (await session.valid(signal)) return;
    trace('Starting OIDC redirects');
    let response = await session.request(`${ORIGIN}/oauth/oidc/login`, { signal });
    let submitted = false;
    for (let step = 0; step < 12; step++) {
        const html = await response.text();
        const available = forms(html, response.url);
        const passwordForm = available.find(form => form.fields.some(field => field.type === 'password'));
        trace(`Authentication step ${step + 1}: ${passwordForm ? 'password form' : 'federation or completion page'}`);
        let form;
        if (passwordForm) {
            if (submitted) { trace('Password form returned after submission; credentials rejected or additional verification required'); throw new Error('UMPASS rejected login. Check credentials or required verification.'); }
            if (new URL(passwordForm.action).origin !== 'https://websso.um.edu.mo') throw new Error('Unexpected password destination');
            form = passwordForm;
            submitted = true;
        } else {
            form = available.find(item => item.fields.some(field => ['SAMLRequest', 'SAMLResponse', 'wresult'].includes(field.name)) && item.fields.every(field => field.type === 'hidden'));
        }
        if (!form) {
            trace('No supported form; validating resulting API session');
            if (await session.valid(signal)) return;
            trace('Resulting API session invalid; unsupported or interactive step');
            throw new Error('Interactive verification or unsupported login step required; no browser was opened.');
        }
        if (form.method !== 'POST') throw new Error('Unsupported authentication form method');
        const body = new URLSearchParams();
        for (const field of form.fields) {
            if (['checkbox', 'submit', 'button'].includes(field.type)) continue;
            body.append(field.name, field.name === 'UserName' && passwordForm ? credentials.username : field.type === 'password' ? credentials.password : field.value);
        }
        trace(passwordForm ? 'Submitting credentials once' : 'Submitting federation form');
        response = await session.request(form.action, { method: 'POST', body, signal });
    }
    throw new Error('Authentication step limit exceeded');
}
module.exports = { Cookie, Session, createKeepaliveSchedule, createSessionPersistence, forms, ORIGIN, login };