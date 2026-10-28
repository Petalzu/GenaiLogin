const assert = require('assert');

const vscode = require('vscode');
suite('Extension Test Suite', () => {
	test('Activation registers commands and makes the idle listener reachable', async () => {
		const extension = vscode.extensions.getExtension('Petalzu.genai-login');
		assert.ok(extension);
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const name of ['connect', 'diagnose', 'credentials', 'disconnect', 'clear', 'models', 'mcp', 'port']) assert.ok(commands.includes(`genai-login.${name}`));
		const port = vscode.workspace.getConfiguration('genai-login').get('port', 58379);
		const response = await fetch(`http://127.0.0.1:${port}/internal/status`, {
			headers: { Authorization: 'Bearer local-browser-session' }, signal: AbortSignal.timeout(3000)
		});
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.service, 'genai-login');
		assert.equal(payload.state.listening, true);
		assert.equal(payload.state.port, port);
	});
	test('One-click drawing MCP enables a native server and discovers its tool inside VS Code', async function () {
		this.timeout(15000);
		const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
		const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
		const extension = vscode.extensions.getExtension('Petalzu.genai-login');
		await extension.activate();
		assert.ok(extension.packageJSON.contributes.mcpServerDefinitionProviders.some(provider => provider.id === 'genai-login.drawing'));
		assert.equal(typeof vscode.lm.registerMcpServerDefinitionProvider, 'function');
		const configuration = vscode.workspace.getConfiguration('genai-login');
		const previous = configuration.inspect('imageMcp.enabled').globalValue;
		const client = new Client({ name: 'genai-vscode-host', version: '1.0.0' });
		try {
			await vscode.commands.executeCommand('genai-login.mcp');
			await vscode.commands.executeCommand('genai-login.mcp');
			assert.equal(vscode.workspace.getConfiguration('genai-login').get('imageMcp.enabled'), true);
			const port = configuration.get('port', 58379);
			await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
				requestInit: { headers: { Authorization: 'Bearer local-browser-session' } }
			}));
			assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['generate_image']);
		} finally {
			await client.close();
			await configuration.update('imageMcp.enabled', previous, vscode.ConfigurationTarget.Global);
		}
	});
	test('Browser authentication child starts and cancels inside the VS Code host without network access', async function () {
		this.timeout(15000);
		const { Session } = require('../dist/auth');
		const { browserLogin } = require('../dist/browser-auth');
		const controller = new AbortController();
		const traces = [];
		try {
			await assert.rejects(browserLogin(new Session(), {}, controller.signal, message => {
				traces.push(message);
				if (message === 'Starting temporary headless Edge') controller.abort();
			}, undefined, false, true, { force: true }));
			assert.ok(traces.includes('Starting temporary headless Edge'));
			assert.ok(!traces.some(message => message.startsWith('Authentication navigation:')));
			assert.ok(!Object.keys(require.cache).some(path => path.includes('playwright-core')));
		} finally { controller.abort(); }
	});
	test('Session-check timeouts recover or remain retryable inside VS Code without MFA', async function () {
		this.timeout(10000);
		const { browserLogin } = require('../dist/browser-auth');
		const { transportCode } = require('../dist/bridge-stream');
		for (const persistent of [false, true]) {
			let checks = 0;
			const session = { valid: async () => {
				if (++checks <= (persistent ? 2 : 1)) throw new DOMException('Check timed out', 'TimeoutError');
				return true;
			} };
			const connect = () => browserLogin(session, {}, undefined, () => {}, { launch: () => assert.fail('unexpected MFA') });
			if (persistent) {
				await assert.rejects(connect(), { name: 'Error', code: 'SESSION_CHECK_TIMEOUT' });
				await connect();
			} else await connect();
			assert.equal(checks, persistent ? 3 : 2);
		}
		assert.equal(transportCode(new DOMException('Timed out', 'TimeoutError')), 'TimeoutError');
	});
	test('Dashboard view is contributed as a Webview', async () => {
		const extension = vscode.extensions.getExtension('Petalzu.genai-login');
		await extension.activate();
		const view = extension.packageJSON.contributes.views['genai-login'].find(item => item.id === 'genai-login.session');
		assert.equal(view.type, 'webview');
		assert.equal(view.name, 'GENAI Login');
		assert.equal(extension.packageJSON.contributes.viewsContainers.activitybar[0].title, 'GENAI Login');
		const { dashboardHtml } = require('../dashboard');
		const html = dashboardHtml();
		assert.match(html, /data-command="connect"/);
		assert.match(html, /Content-Security-Policy/);
		assert.match(html, /<title>GENAI Login<\/title>/);
		assert.match(html, /<h1>GENAI Login/);
	});
	test('Independent history files survive replacement through VS Code filesystem APIs', async () => {
		const { mkdtemp } = require('node:fs/promises');
		const { tmpdir } = require('node:os');
		const { join } = require('node:path');
		const { createHistory, createHistoryFiles } = require('../stats');
		const directory = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'genai-history-vscode-')));
		const storage = () => ({ get() {}, keys: () => [], update: () => assert.fail('history must not write a shared Memento') });
		const errors = [];
		const create = () => createHistory(storage(), () => errors.push('history error'),
			createHistoryFiles(vscode.workspace.fs, directory, vscode.Uri.joinPath));
		try {
			const first = create(); const second = create();
			first.start(); second.start(); await Promise.all([first.flush(), second.flush()]);
			first.start(); await first.flush();
			const restored = create(); await restored.reload();
			assert.equal(restored.snapshot().requests, 3);
			assert.deepEqual(errors, []);
			assert.equal((await vscode.workspace.fs.readDirectory(directory)).length, 2);
		} finally { await vscode.workspace.fs.delete(directory, { recursive: true }); }
	});
});
