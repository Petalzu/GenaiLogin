const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Session, createKeepaliveSchedule, createSessionPersistence, forms, login } = require('../auth');
test('forms preserve hidden values and decode entities', () => {
    const [form] = forms('<form method="post" action="/login?a=1&amp;b=2"><input name="csrf" type="hidden" value="a&amp;b"><input name="Password" type="password"></form>', 'https://websso.um.edu.mo/');
    assert.equal(form.action, 'https://websso.um.edu.mo/login?a=1&b=2');
    assert.equal(form.fields[0].value, 'a&b');
});
test('untrusted destinations are refused before fetch', async () => {
    await assert.rejects(new Session().request('https://example.com'), /Untrusted/);
    await assert.rejects(new Session().request('http://websso.um.edu.mo'), /Untrusted/);
});
test('rejected credentials are submitted only once', async () => {
    let posts = 0;
    const session = { valid: async () => false, request: async (url, options) => {
        if (options.method === 'POST') { posts++; assert.equal(options.body.get('UserName'), 'test'); assert.equal(options.body.get('Password'), 'dummy'); }
        return { url: 'https://websso.um.edu.mo/adfs/ls/', text: async () => '<form method="post"><input name="UserName" type="email"><input name="Password" type="password"></form>' };
    } };
    await assert.rejects(login(session, { username: 'test', password: 'dummy' }), /rejected/);
    assert.equal(posts, 1);
});
test('valid saved session needs no login request', async () => {
    await login({ valid: async () => true, request: () => assert.fail('unexpected login') }, {});
});
test('redirect cookies are retained and restored', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async (url, options) => {
        calls++;
        if (calls === 1) return new Response(null, { status: 302, headers: { location: '/next', 'set-cookie': 'session=test; Secure; Path=/' } });
        assert.match(options.headers.Cookie, /session=test/);
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    try {
        const session = new Session(); await session.request('https://chat.genai.um.edu.mo/');
        const restored = new Session(JSON.stringify(session.jar.toJSON()));
        assert.match(await restored.jar.getCookieString('https://chat.genai.um.edu.mo/'), /session=test/);
    } finally { global.fetch = original; }
});
test('session checks distinguish expiry from transient responses and release bodies', async () => {
    for (const status of [200, 401, 403, 429, 500, 503]) {
        let cancelled = false;
        const session = new Session();
        session.request = async () => ({ status, ok: status === 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: { cancel: async () => { cancelled = true; } }
        });
        if (status === 200) assert.equal(await session.valid(), true);
        else if (status === 401) assert.equal(await session.valid(), false);
        else await assert.rejects(session.valid(), { code: 'SESSION_UNAVAILABLE', status });
        assert.equal(cancelled, true);
    }
});
test('only verified identity HTML is treated as an expired session', async () => {
    for (const url of ['https://websso.um.edu.mo/adfs/ls/', 'https://login.um.edu.mo/login', 'https://chat.genai.um.edu.mo/api/v1/models']) {
        const session = new Session();
        session.request = async () => ({ status: 200, ok: true, url,
            headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }), body: null });
        if (new URL(url).hostname === 'chat.genai.um.edu.mo') await assert.rejects(session.valid(), { code: 'SESSION_UNAVAILABLE' });
        else assert.equal(await session.valid(), false);
    }
});
test('session runtime does not load the HTML parser', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../auth'))}); if (Object.keys(require.cache).some(file => /node_modules[\\\\/]cheerio[\\\\/]/.test(file))) process.exitCode = 1;`]);
    assert.equal(result.status, 0, result.stderr?.toString());
});
test('session persistence skips access-only changes and reports failures without rejecting', async () => {
    let cookie = { key: 'token', value: 'first', lastAccessed: 'earlier' };
    let writes = 0;
    const states = [];
    const persistence = createSessionPersistence({ jar: { toJSON: () => ({ cookies: [cookie] }) } }, {
        store: async () => { writes++; throw new Error('disk unavailable'); }
    }, () => true, state => states.push(state), true);
    cookie = { ...cookie, lastAccessed: 'later' };
    assert.equal(await persistence.save(), true);
    assert.equal(writes, 0);
    cookie = { ...cookie, value: 'changed' };
    assert.equal(await persistence.save(), false);
    assert.deepEqual(states, ['error']);
    assert.equal(writes, 1);
});
test('session writes are coalesced and serialized across connection changes', async () => {
    const { setImmediate: nextTurn } = require('node:timers/promises');
    const writes = [];
    const releases = [];
    let current = true;
    let value = 'first';
    const secrets = { store: async (key, snapshot) => {
        writes.push(JSON.parse(snapshot).cookies[0].value);
        await new Promise(resolve => releases.push(resolve));
    } };
    const session = { jar: { toJSON: () => ({ cookies: [{ value }] }) } };
    const first = createSessionPersistence(session, secrets, () => current);
    const saving = first.save();
    await nextTurn();
    value = 'second'; first.save(); value = 'third'; first.save();
    releases.shift()(); await nextTurn();
    assert.deepEqual(writes, ['first', 'third']);
    const second = createSessionPersistence({ jar: { toJSON: () => ({ cookies: [{ value: 'new-connection' }] }) } }, secrets, () => true);
    current = false;
    const replacement = second.save();
    await nextTurn();
    assert.equal(writes.length, 2);
    releases.shift()(); await saving; await nextTurn();
    assert.deepEqual(writes, ['first', 'third', 'new-connection']);
    releases.shift()(); await replacement;
    assert.equal(await first.save(), false);
    await Promise.all([first.flush(), second.flush()]);
});
test('session check stops at a trusted login redirect without fetching MFA pages', async () => {
    const original = global.fetch;
    try {
        for (const destination of ['https://login.um.edu.mo/auth/', '/oauth/oidc/login', '/auth?redirect=%2F', '/auth/', 'https://websso.um.edu.mo/adfs/ls/']) {
            let calls = 0;
            global.fetch = async () => {
                calls++; assert.equal(calls, 1);
                return new Response(null, { status: 302, headers: { location: destination } });
            };
            assert.equal(await new Session().valid(), false);
        }
    } finally { global.fetch = original; }
});

test('health checks use the authentication endpoint and preserve Retry-After without exposing tokens', async () => {
    const session = new Session();
    session.request = async (url, options) => {
        assert.equal(url, 'https://chat.genai.um.edu.mo/api/v1/auths/');
        assert.equal(options.checkSession, true);
        return new Response('{}', { status: 429, headers: { 'retry-after': '180' } });
    };
    await assert.rejects(session.valid(), { code: 'SESSION_UNAVAILABLE', status: 429, retryAfterMs: 180000 });
});

test('token expiry metadata respects both Cookie and JWT deadlines without granting validity', async () => {
    const session = new Session();
    const exp = Math.floor(Date.now() / 1000) + 600;
    const value = 'header.' + Buffer.from(JSON.stringify({ exp, id: 'private' })).toString('base64url') + '.signature';
    await session.jar.setCookie(`token=${value}; Path=/; Secure`, 'https://chat.genai.um.edu.mo');
    assert.equal(session.expiresAt(), exp * 1000);
    await session.jar.setCookie('token=opaque; Path=/; Secure', 'https://chat.genai.um.edu.mo');
    assert.equal(session.expiresAt(), null);
    await session.jar.setCookie(`token=${value}; Path=/; Secure; Expires=${new Date((exp - 300) * 1000).toUTCString()}`, 'https://chat.genai.um.edu.mo');
    assert.equal(session.expiresAt(), (exp - 300) * 1000);
});

test('activity suppresses redundant checks but never exceeds a five-minute health gap', () => {
    let now = 0;
    const schedule = createKeepaliveSchedule({}, () => now);
    assert.equal(schedule.snapshot().nextCheckAt, 120000);
    for (now = 30000; now <= 270000; now += 30000) schedule.activity();
    assert.equal(schedule.snapshot().nextCheckAt, 300000);
    assert.equal(schedule.snapshot().activityVersion, 9);
    schedule.checked();
    assert.equal(schedule.snapshot().nextCheckAt, now + 120000);
});

test('expiry deadline cannot be postponed by chat activity and does not cause tight polling', () => {
    let now = 0;
    const schedule = createKeepaliveSchedule({ expiresAt: () => 180000 }, () => now);
    now = 110000; schedule.activity();
    assert.equal(schedule.snapshot().nextCheckAt, 120000);
    now = 120000; schedule.checked();
    assert.equal(schedule.snapshot().expiring, true);
    assert.equal(schedule.snapshot().nextCheckAt, 180000);
    now = 180000; schedule.checked();
    assert.equal(schedule.snapshot().nextCheckAt, 210000);
});

test('failed health checks back off, honor rate limits and reset after real success', () => {
    let now = 0;
    const schedule = createKeepaliveSchedule({}, () => now);
    for (const delay of [30000, 60000, 120000, 240000, 300000]) {
        schedule.failed();
        assert.equal(schedule.snapshot().nextCheckAt, now + delay);
        now += delay;
    }
    schedule.failed(600000);
    assert.equal(schedule.snapshot().nextCheckAt, now + 600000);
    schedule.activity();
    assert.equal(schedule.snapshot().nextCheckAt, now + 600000);
    schedule.checked();
    assert.equal(schedule.snapshot().nextCheckAt, now + 120000);
});
test('success after a failed health attempt does not produce immediate repeated checks', () => {
    let now = 600000;
    const schedule = createKeepaliveSchedule({}, () => now);
    now += 300000; schedule.failed(); schedule.activity();
    assert.equal(schedule.snapshot().nextCheckAt, now + 120000);
});
test('existing stream bytes do not prove that an expired token can accept new requests', () => {
    let now = 0;
    const schedule = createKeepaliveSchedule({}, () => now);
    now = 30000; schedule.activity(false);
    assert.equal(schedule.snapshot().activityVersion, 0);
    assert.equal(schedule.snapshot().nextCheckAt, 150000);
    schedule.activity();
    assert.equal(schedule.snapshot().activityVersion, 1);
});

test('two-hour activity and idle workloads maintain bounded health checks', () => {
    for (const busy of [false, true]) {
        let now = 0;
        const schedule = createKeepaliveSchedule({}, () => now);
        const checks = [];
        for (now = 10000; now <= 7200000; now += 10000) {
            if (busy) schedule.activity();
            if (schedule.snapshot().nextCheckAt <= now) { checks.push(now); schedule.checked(); }
        }
        assert.equal(checks.length, busy ? 24 : 60);
        const interval = busy ? 300000 : 120000;
        for (let index = 0; index < checks.length; index++) assert.equal(checks[index] - (checks[index - 1] || 0), interval);
    }
});

test('sleep resumes one overdue check and a rotated token moves the expiry boundary', () => {
    let now = 0, expiry = 180000;
    const schedule = createKeepaliveSchedule({ expiresAt: () => expiry }, () => now);
    now = 600000;
    assert.equal(schedule.snapshot().nextCheckAt, now);
    expiry = now + 3600000;
    schedule.checked();
    assert.equal(schedule.snapshot().nextCheckAt, now + 120000);
    assert.equal(schedule.snapshot().expiring, false);
});