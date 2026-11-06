const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const executablePath = process.env.GENAI_TEST_VSCODE_PATH;

test('installed bridge starts in Agents alone and survives editor-window handover', {
    skip: !executablePath, timeout: 90000
}, async () => {
    const { _electron } = require('playwright-core');
    const { requestSharedState } = require('../dist/shared-control');
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const root = await fs.mkdtemp(join(tmpdir(), 'genai-agents-'));
    const userData = join(root, 'data');
    const extensions = join(root, 'extensions');
    const manifest = require('../package.json');
    const extension = join(extensions, `${manifest.publisher}.${manifest.name}-${manifest.version}`);
    const args = [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--locale=en',
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates',
        '--disable-extension=GitHub.copilot-chat'];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
    let app;
    async function waitFor(check, message) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const value = await check();
            if (value) return value;
            await delay(100);
        }
        assert.fail(message);
    }
    async function stateWhere(check) {
        return waitFor(async () => {
            try {
                const payload = await requestSharedState(port, 'status', {
                    headers: { 'x-genai-status': 'brief' }, signal: AbortSignal.timeout(1000)
                });
                return check(payload.state) ? payload.state : undefined;
            } catch (error) {
                if (error.code !== 'ECONNREFUSED') throw error;
            }
        }, 'The expected bridge owner did not become reachable');
    }
    async function openWindow(agents) {
        const opened = app.waitForEvent('window', { timeout: 15000 });
        const child = spawn(executablePath, [...args, agents ? '--agents' : '--new-window'], { env, stdio: 'ignore' });
        await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Window launch failed: ${code}`)));
        });
        return opened;
    }
    async function waitForActivations(count) {
        await waitFor(async () => {
            const files = await fs.readdir(join(userData, 'logs'), { recursive: true });
            let activations = 0;
            for (const file of files.filter(name => name.endsWith('exthost.log'))) {
                const log = await fs.readFile(join(userData, 'logs', file), 'utf8');
                activations += (log.match(/_doActivateExtension Petalzu\.genai-login,.*activationEvent: 'onStartupFinished'/g) || []).length;
            }
            return activations >= count;
        }, 'The installed extension did not activate automatically in every window');
    }
    async function closeWindow(page) {
        const closed = page.waitForEvent('close');
        const browserWindow = await app.browserWindow(page);
        await browserWindow.evaluate(window => window.close());
        await closed;
    }
    try {
        await fs.mkdir(extension, { recursive: true });
        await fs.mkdir(join(userData, 'User'), { recursive: true });
        await fs.writeFile(join(extension, 'package.json'), JSON.stringify(manifest));
        await fs.cp(join(__dirname, '..', 'dist'), join(extension, 'dist'), { recursive: true });
        await fs.cp(join(__dirname, '..', 'media'), join(extension, 'media'), { recursive: true });
        await fs.writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
            'genai-login.port': port, 'genai-login.imageMcp.enabled': false,
            'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'window.restoreWindows': 'none'
        }));
        app = await _electron.launch({ executablePath, args: [...args, '--agents'], env, timeout: 20000 });
        const initialAgents = await app.firstWindow();
        await initialAgents.waitForURL(/\/sessions\//);
        const initial = await stateWhere(state => state.listening && !state.active);
        await waitForActivations(1);
        assert.equal(app.windows().length, 1, 'Cold startup must not require an editor window');
        const editor = await openWindow(false);
        await editor.waitForURL(/\/workbench\//);
        await waitForActivations(2);
        await closeWindow(initialAgents);
        const editorState = await stateWhere(state => state.listening && state.instance !== initial.instance);
        assert.equal(editorState.active, false);
        const agents = await openWindow(true);
        await agents.waitForURL(/\/sessions\//);
        await waitForActivations(3);
        await closeWindow(editor);
        const final = await stateWhere(state => state.listening && state.instance !== editorState.instance);
        assert.equal(final.active, false);
        assert.equal(final.connection, 'disconnected');
        assert.equal(app.windows().length, 1);
        const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
            headers: { Authorization: 'Bearer local-browser-session' }, signal: AbortSignal.timeout(3000)
        });
        assert.equal(models.status, 200);
        assert.deepEqual((await models.json()).data.map(model => model.id), require('../genai-models.json').models.map(model => model.id));
        assert.equal((await stateWhere(state => state.listening)).active, false, 'Model discovery must not start login');
        await app.close();
        app = undefined;
        await assert.rejects(requestSharedState(port, 'status'), { code: 'ECONNREFUSED' });
    } finally {
        try { await app?.close(); } finally {
            await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    }
});
