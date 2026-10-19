const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { handleImageMcp } = require(process.env.GENAI_MCP_MODULE || '../image-mcp');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmf0AAAAASUVORK5CYII=', 'base64');

async function fixture(options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'genai-image-mcp-'));
    const controller = new AbortController();
    const calls = [];
    const server = http.createServer((request, response) => {
        void handleImageMcp(request, response, {
            port: 58480, directory, signal: controller.signal,
            detectImageMimeType: bytes => bytes.subarray(0, 8).equals(png.subarray(0, 8)) ? 'image/png' : undefined,
            fetch: async (url, settings) => {
                calls.push({ url, settings });
                return options.fetch ? options.fetch(url, settings) : Response.json({ data: [{ b64_json: png.toString('base64') }] });
            }
        }).catch(error => { if (!response.destroyed) response.destroy(error); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
    const client = new Client({ name: 'genai-mcp-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    return { client, directory, calls, controller, url, async dispose() {
        controller.abort();
        await client.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    } };
}

test('MCP initialization and discovery expose one drawing tool without image requests', async () => {
    const harness = await fixture();
    try {
        const tools = (await harness.client.listTools()).tools;
        assert.deepEqual(tools.map(tool => tool.name), ['generate_image']);
        assert.equal(tools[0].title, 'Qwen Image 2.1');
        assert.equal(tools[0].annotations.idempotentHint, false);
        assert.deepEqual(tools[0].inputSchema.required, ['prompt']);
        assert.equal(harness.calls.length, 0);
        assert.deepEqual(await readdir(harness.directory), []);
    } finally { await harness.dispose(); }
});

test('drawing tool uses the fixed local model, returns image content and saves original bytes', async () => {
    const harness = await fixture();
    try {
        const result = await harness.client.callTool({ name: 'generate_image', arguments: { prompt: 'a red apple', size: '1536x1024', n: 1 } });
        assert.ok(!result.isError);
        assert.equal(harness.calls.length, 1);
        const { url, settings } = harness.calls[0];
        assert.equal(url, 'http://127.0.0.1:58480/v1/images/generations');
        assert.equal(settings.headers.Authorization, 'Bearer local-browser-session');
        assert.equal(settings.redirect, 'error');
        assert.deepEqual(JSON.parse(settings.body), { model: 'qwen-image-2.1', prompt: 'a red apple', size: '1536x1024', n: 1 });
        assert.equal(result.structuredContent.model, 'qwen-image-2.1');
        const file = result.structuredContent.files[0];
        assert.equal(file.startsWith(join(harness.directory, 'generated-images')), true);
        assert.match(file, /\.png$/);
        assert.deepEqual(await readFile(file), png);
        assert.deepEqual(result.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    } finally { await harness.dispose(); }
});

test('tool rejects invalid input before forwarding and never accepts an external endpoint', async () => {
    const harness = await fixture();
    try {
        for (const args of [{ prompt: '' }, { prompt: '   ' }, { prompt: 'image', n: 7 }, { prompt: 'image', n: 0 },
            { prompt: 'image', n: null }, { prompt: 'image', size: null }, { prompt: 'image', size: 'invalid' },
            { prompt: 'x'.repeat(32001) }, { prompt: '\ud83d\ude00'.repeat(16001) }]) {
            const result = await harness.client.callTool({ name: 'generate_image', arguments: args });
            assert.equal(result.isError, true);
        }
        assert.equal(harness.calls.length, 0);
        await assert.rejects(harness.client.callTool({ name: 'generate_image', arguments: { prompt: 'an apple' }, task: { ttl: 60000 } }));
        assert.equal(harness.calls.length, 0);
        const result = await harness.client.callTool({ name: 'generate_image', arguments: {
            prompt: 'a green apple', base_url: 'https://untrusted.example/v1', model: 'other', output_path: '../escape.png'
        } });
        assert.ok(!result.isError);
        assert.equal(harness.calls.length, 1);
        assert.equal(harness.calls[0].url, 'http://127.0.0.1:58480/v1/images/generations');
        assert.deepEqual(JSON.parse(harness.calls[0].settings.body), { model: 'qwen-image-2.1', prompt: 'a green apple', size: '1024x1024', n: 1 });
        assert.equal(result.structuredContent.files[0].startsWith(harness.directory), true);
    } finally { await harness.dispose(); }
});

test('multiple images receive separate local files and preview blocks', async () => {
    const harness = await fixture({ fetch: async () => Response.json({ data: Array.from({ length: 3 }, () => ({ b64_json: png.toString('base64') })) }) });
    try {
        const result = await harness.client.callTool({ name: 'generate_image', arguments: { prompt: 'three apples', n: 3 } });
        assert.ok(!result.isError);
        assert.equal(result.structuredContent.files.length, 3);
        assert.equal(new Set(result.structuredContent.files).size, 3);
        assert.equal(result.content.filter(block => block.type === 'image').length, 3);
        for (const file of result.structuredContent.files) assert.deepEqual(await readFile(file), png);
    } finally { await harness.dispose(); }
});

test('upstream failures and invalid images do not save files or retry requests', async () => {
    for (const response of [
        new Response('private upstream details', { status: 401 }),
        Response.json({ data: [] }),
        Response.json({ data: [{ url: 'https://untrusted.example/image.png' }] }),
        Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }),
        Response.json({ data: Array.from({ length: 7 }, () => ({ b64_json: png.toString('base64') })) })
    ]) {
        const harness = await fixture({ fetch: async () => response });
        try {
            const result = await harness.client.callTool({ name: 'generate_image', arguments: { prompt: 'an apple' } });
            assert.equal(result.isError, true);
            assert.equal(harness.calls.length, 1);
            assert.equal(JSON.stringify(result).includes('private upstream details'), false);
            assert.deepEqual(await readdir(harness.directory), []);
        } finally { await harness.dispose(); }
    }
});

test('a later invalid image removes earlier files and noncanonical base64 is rejected', async () => {
    for (const data of [
        [{ b64_json: png.toString('base64') }, { b64_json: Buffer.from('not an image').toString('base64') }],
        [{ b64_json: png.toString('base64') + '\n' }],
        [{ b64_json: 'A'.repeat(28 * 1024 * 1024) }]
    ]) {
        const harness = await fixture({ fetch: async () => Response.json({ data }) });
        try {
            const result = await harness.client.callTool({ name: 'generate_image', arguments: { prompt: 'an apple' } });
            assert.equal(result.isError, true);
            assert.equal(harness.calls.length, 1);
            const folders = await readdir(harness.directory);
            if (folders.includes('generated-images')) assert.deepEqual(await readdir(join(harness.directory, 'generated-images')), []);
        } finally { await harness.dispose(); }
    }
});

test('aborting the owner cancels image forwarding without saving or retrying', { timeout: 5000 }, async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const harness = await fixture({ fetch: async (url, settings) => {
        started();
        return new Promise((resolve, reject) => settings.signal.addEventListener('abort', () => reject(settings.signal.reason), { once: true }));
    } });
    try {
        const pending = harness.client.callTool({ name: 'generate_image', arguments: { prompt: 'an apple' } });
        await ready;
        harness.controller.abort();
        await assert.rejects(pending);
        assert.equal(harness.calls.length, 1);
        assert.equal(harness.calls[0].settings.signal.aborted, true);
        assert.deepEqual(await readdir(harness.directory), []);
    } finally { await harness.dispose(); }
});

test('client cancellation aborts the image HTTP request without automatic retry', { timeout: 5000 }, async () => {
    let started, aborted;
    const ready = new Promise(resolve => { started = resolve; });
    const cancelled = new Promise(resolve => { aborted = resolve; });
    const harness = await fixture({ fetch: async (url, settings) => {
        started();
        return new Promise((resolve, reject) => settings.signal.addEventListener('abort', () => {
            aborted(); reject(settings.signal.reason);
        }, { once: true }));
    } });
    try {
        const controller = new AbortController();
        const pending = harness.client.callTool({ name: 'generate_image', arguments: { prompt: 'an apple' } }, undefined, { signal: controller.signal });
        await ready;
        controller.abort();
        await assert.rejects(pending);
        await cancelled;
        assert.equal(harness.calls.length, 1);
        assert.equal(harness.calls[0].settings.signal.aborted, true);
        assert.deepEqual(await readdir(harness.directory), []);
    } finally { await harness.dispose(); }
});

test('malformed and oversized MCP bodies fail without calling the image API', async () => {
    const harness = await fixture();
    try {
        for (const [body, status] of [['{broken', 400], ['a'.repeat(256 * 1024 + 1), 413]]) {
            const response = await fetch(harness.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body });
            assert.equal(response.status, status);
            assert.ok((await response.json()).error);
        }
        assert.equal(harness.calls.length, 0);
    } finally { await harness.dispose(); }
});