const assert = require('assert');

const vscode = require('vscode');
const http = require('node:http');

suite('Extension Test Suite', () => {
	test('Activation registers commands without opening a server', async () => {
		const original = http.Server.prototype.listen;
		let listens = 0;
		http.Server.prototype.listen = function (...args) { listens++; return original.apply(this, args); };
		try {
			const extension = vscode.extensions.getExtension('local-genai.genai-login');
			assert.ok(extension);
			await extension.activate();
			const commands = await vscode.commands.getCommands(true);
			for (const name of ['connect', 'diagnose', 'credentials', 'disconnect', 'clear', 'models', 'port']) assert.ok(commands.includes(`genai-login.${name}`));
			assert.equal(listens, 0);
		} finally { http.Server.prototype.listen = original; }
	});
	test('Dashboard view is contributed as a Webview', async () => {
		const extension = vscode.extensions.getExtension('local-genai.genai-login');
		await extension.activate();
		const view = extension.packageJSON.contributes.views['genai-login'].find(item => item.id === 'genai-login.session');
		assert.equal(view.type, 'webview');
		const { dashboardHtml } = require('../dashboard');
		const html = dashboardHtml();
		assert.match(html, /data-command="connect"/);
		assert.match(html, /Content-Security-Policy/);
	});
});
