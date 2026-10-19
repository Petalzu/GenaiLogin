const { build } = require('esbuild');
const { mkdir, copyFile, rm, readFile, readdir, writeFile } = require('node:fs/promises');
const { resolve, dirname } = require('node:path');

async function main() {
    const modules = ['extension', 'auth', 'auth-forms', 'browser-auth', 'dashboard', 'stats', 'bridge-stream', 'copilot-config', 'copilot-models', 'upstream', 'image-mcp'];
    const dependencies = new Set();
    await rm(resolve(__dirname, 'dist'), { recursive: true, force: true });
    await mkdir(resolve(__dirname, 'dist'), { recursive: true });
    await Promise.all(modules.map(async name => {
        const result = await build({
            entryPoints: [resolve(__dirname, name + '.js')],
            outfile: resolve(__dirname, 'dist', name + '.js'),
            bundle: true,
            platform: 'node',
            target: 'node22',
            format: 'cjs',
            conditions: ['import', 'node'],
            alias: {
                'jsonc-parser': resolve(dirname(require.resolve('jsonc-parser/package.json')), require('jsonc-parser/package.json').module),
                ...(name === 'image-mcp' ? { ajv: dirname(require.resolve('ajv/package.json', {
                    paths: [dirname(require.resolve('@modelcontextprotocol/sdk/server/index.js'))]
                })) } : {})
            },
            minify: true,
            legalComments: 'external',
            external: ['vscode', 'playwright-core', ...modules.map(module => './' + module)],
            metafile: true
        });
        if (Object.keys(result.metafile.inputs).some(path => path.includes('playwright-core/'))) throw new Error('Playwright must retain its runtime assets');
        for (const path of Object.keys(result.metafile.inputs)) {
            const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(path.replace(/\\/g, '/'));
            if (match) dependencies.add(resolve(__dirname, match[1]));
        }
    }));
    const notices = [];
    for (const directory of [...dependencies].sort()) {
        const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
        const names = (await readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name));
        if (!names.some(name => /^(?:licen[sc]e|copying)/i.test(name))) {
            if (!metadata.license) throw new Error('Missing license for bundled dependency ' + metadata.name);
            notices.push(`${metadata.name}@${metadata.version} - published package metadata\n${JSON.stringify(metadata, null, 2)}`);
        }
        for (const name of names) notices.push(`${metadata.name}@${metadata.version} (${metadata.license || 'see below'}) - ${name}\n${await readFile(resolve(directory, name), 'utf8')}`);
    }
    await writeFile(resolve(__dirname, 'dist', 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n' + '='.repeat(72) + '\n\n'));
    await copyFile(resolve(__dirname, 'genai-models.json'), resolve(__dirname, 'dist', 'genai-models.json'));
}

main().catch(error => { console.error(error); process.exitCode = 1; });