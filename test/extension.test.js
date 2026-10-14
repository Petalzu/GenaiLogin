const assert = require('assert');

const vscode = require('vscode');
const http = require('node:http');

suite('Extension Test Suite', () => {
	test('Activation registers commands without opening a server', async () => {
		const original = http.Server.prototype.listen;
		let listens = 0;
		http.Server.prototype.listen = function (...args) { listens++; return original.apply(this, args); };
		try {
			const extension = vscode.extensions.getExtension('Petalzu.genai-login');
			assert.ok(extension);
			await extension.activate();
			const commands = await vscode.commands.getCommands(true);
			for (const name of ['connect', 'diagnose', 'credentials', 'disconnect', 'clear', 'models', 'port']) assert.ok(commands.includes(`genai-login.${name}`));
			assert.equal(listens, 0);
		} finally { http.Server.prototype.listen = original; }
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
