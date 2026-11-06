import { defineConfig } from '@vscode/test-cli';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default defineConfig((async () => {
	const probe = createServer();
	await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
	const port = probe.address().port;
	await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
	const agents = process.env.GENAI_TEST_AGENTS === '1';
	const userData = new URL(agents ? './.vscode-test/isolated-agents-data/' : './.vscode-test/isolated-user-data/', import.meta.url);
	await mkdir(new URL('User/', userData), { recursive: true });
	await writeFile(new URL('User/settings.json', userData), JSON.stringify({
		'genai-login.port': port,
		'genai-login.imageMcp.enabled': false
	}));
	return {
		files: 'test/**/*.test.js',
		...(process.env.GENAI_TEST_VSCODE_PATH ? { useInstallation: { fromPath: process.env.GENAI_TEST_VSCODE_PATH } } : {}),
		env: { GENAI_TEST_AGENTS: agents ? '1' : '0' },
		launchArgs: ['--user-data-dir=' + fileURLToPath(userData), ...(agents ? ['--agents'] : [])]
	};
})());
