import { defineConfig } from '@vscode/test-cli';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default defineConfig((async () => {
	const probe = createServer();
	await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
	const port = probe.address().port;
	await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
	const userData = new URL('./.vscode-test/isolated-user-data/', import.meta.url);
	await mkdir(new URL('User/', userData), { recursive: true });
	await writeFile(new URL('User/settings.json', userData), JSON.stringify({
		'genai-login.port': port,
		'genai-login.imageMcp.enabled': false
	}));
	return {
		files: 'test/**/*.test.js',
		launchArgs: ['--user-data-dir=' + fileURLToPath(userData)]
	};
})());
