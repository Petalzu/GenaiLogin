const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest, ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
const { randomUUID } = require('node:crypto');
const { mkdir, writeFile, unlink } = require('node:fs/promises');
const { join } = require('node:path');

const owners = new WeakMap();
const imageTool = {
    name: 'generate_image',
    title: 'Qwen Image 2.1',
    description: 'Generate images from a text prompt using GENAI Qwen Image 2.1. Returns image previews and saves original files on the local VS Code machine. Authentication and MFA may be required on the first call. Do not retry automatically after cancellation or an error.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: { type: 'string', minLength: 1, maxLength: 32000, description: 'Detailed description of the image to generate.' },
            size: { type: 'string', pattern: '^[1-9]\\d{1,4}x[1-9]\\d{1,4}$', description: 'Image dimensions, for example 1024x1024. Defaults to 1024x1024.' },
            n: { type: 'integer', minimum: 1, maximum: 6, description: 'Number of images, from 1 to 6. Defaults to 1.' }
        },
        required: ['prompt']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
};
let schemaValidator, validateImageInput;
const jsonSchemaValidator = { getValidator: schema => (schemaValidator ??= new AjvJsonSchemaValidator()).getValidator(schema) };

async function readImages(response, signal) {
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GENAI image request failed (HTTP ${response.status}). Check the GENAI connection and MFA before retrying.`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
        signal.throwIfAborted();
        size += chunk.byteLength;
        if (size > 28 * 1024 * 1024) throw new Error('GENAI image response exceeds the size limit.');
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks, size).toString('utf8');
    chunks.length = 0;
    const payload = JSON.parse(text);
    if (!Array.isArray(payload.data) || !payload.data.length || payload.data.length > 6) throw new Error('GENAI returned no valid images.');
    let total = 0;
    for (const image of payload.data) {
        if (typeof image?.b64_json !== 'string') throw new Error('GENAI returned invalid image data.');
        total += Buffer.byteLength(image.b64_json, 'base64');
        if (total > 20 * 1024 * 1024) throw new Error('GENAI returned invalid or oversized image data.');
    }
    return payload.data;
}

function createSession({ port, directory, signal, detectImageMimeType, fetch: fetchImage = fetch }, sessions) {
    const operations = new Map();
    const server = new Server({ name: 'genai-qwen-image', version: '1.0.0' }, { capabilities: { tools: {} }, jsonSchemaValidator });
    const session = { server, operations };
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: id => { sessions.set(id, session); }
    });
    session.transport = transport;
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [imageTool] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (request.params.task) throw new McpError(ErrorCode.InvalidParams, 'Task-based image generation is not supported.');
        const args = request.params.arguments || {};
        const input = { prompt: typeof args.prompt === 'string' ? args.prompt.trim() : args.prompt,
            ...(args.size !== undefined ? { size: args.size } : {}), ...(args.n !== undefined ? { n: args.n } : {}) };
        validateImageInput ??= jsonSchemaValidator.getValidator(imageTool.inputSchema);
        if (request.params.name !== imageTool.name || !validateImageInput(input).valid || input.prompt.length > 32000) {
            return { isError: true, content: [{ type: 'text', text: 'Invalid generate_image arguments. Supply a non-empty prompt, a valid size and an image count from 1 to 6.' }] };
        }
        const { prompt, size = '1024x1024', n = 1 } = input;
        const operationSignal = AbortSignal.any([signal, extra.signal, ...(operations.has(extra.requestId) ? [operations.get(extra.requestId).signal] : [])]);
        const files = [];
        let progressTimer;
        try {
            operationSignal.throwIfAborted();
            if (!directory) throw new Error('GENAI local image storage is unavailable.');
            const progressToken = extra._meta?.progressToken;
            if (progressToken !== undefined) {
                let progress = 0;
                progressTimer = setInterval(() => {
                    void extra.sendNotification({ method: 'notifications/progress', params: {
                        progressToken, progress: ++progress, message: 'Waiting for GENAI image generation or MFA.'
                    } }).catch(() => {});
                }, 15000);
                progressTimer.unref?.();
            }
            const result = await fetchImage(`http://127.0.0.1:${port}/v1/images/generations`, {
                method: 'POST', redirect: 'error', signal: operationSignal,
                headers: { Authorization: 'Bearer local-browser-session', 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'qwen-image-2.1', prompt, size, n })
            });
            const images = await readImages(result, operationSignal);
            operationSignal.throwIfAborted();
            const folder = join(directory, 'generated-images');
            const content = [];
            for (const image of images) {
                operationSignal.throwIfAborted();
                const bytes = Buffer.from(image.b64_json, 'base64');
                const mimeType = detectImageMimeType(bytes);
                if (!mimeType || bytes.toString('base64') !== image.b64_json) throw new Error('GENAI returned invalid or oversized image data.');
                if (!content.length) await mkdir(folder, { recursive: true });
                const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
                const file = join(folder, `qwen-image-${randomUUID()}.${extension}`);
                files.push(file);
                await writeFile(file, bytes, { flag: 'wx', signal: operationSignal });
                content.push({ type: 'image', data: image.b64_json, mimeType });
            }
            operationSignal.throwIfAborted();
            return {
                content: [{ type: 'text', text: `Generated with qwen-image-2.1. Saved on the local VS Code machine:\n${files.join('\n')}` },
                    ...content],
                structuredContent: { model: 'qwen-image-2.1', files }
            };
        } catch (error) {
            await Promise.allSettled(files.map(file => unlink(file)));
            return { isError: true, content: [{ type: 'text', text: operationSignal.aborted
                ? 'Image generation was cancelled. No automatic retry was made.'
                : /^(GENAI|Image)/.test(error.message) ? error.message : 'GENAI image generation failed. Check the connection, login and output storage before retrying.' }] };
        } finally { clearInterval(progressTimer); }
    });
    return session;
}

async function handleImageMcp(request, response, options) {
    const { signal } = options;
    signal.throwIfAborted();
    const fail = (status, code, message) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
    };
    let body;
    if (request.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            signal.throwIfAborted();
            size += chunk.length;
            if (size > 256 * 1024) return fail(413, -32600, 'MCP request too large');
            chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return fail(400, -32700, 'Invalid JSON'); }
    }
    let sessions = owners.get(signal);
    if (!sessions) {
        sessions = new Map();
        owners.set(signal, sessions);
        signal.addEventListener('abort', () => {
            for (const session of sessions.values()) {
                clearTimeout(session.expiry);
                void session.server.close().catch(() => {});
            }
            sessions.clear();
            owners.delete(signal);
        }, { once: true });
    }
    const id = request.headers['mcp-session-id'];
    let session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) {
        if (id) return fail(404, -32000, 'MCP session not found; reconnect the server.');
        if (request.method !== 'POST' || !isInitializeRequest(body)) return fail(400, -32000, 'MCP initialization required.');
        if (sessions.size >= 32) return fail(503, -32000, 'Too many MCP sessions; reconnect GENAI.');
        session = createSession(options, sessions);
        await session.server.connect(session.transport);
        const closed = session.transport.onclose;
        session.transport.onclose = () => { clearTimeout(session.expiry); closed?.(); sessions.delete(session.transport.sessionId); };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const requestId = body && !Array.isArray(body) ? body.id : undefined;
    if (requestId !== undefined) {
        if (session.operations.has(requestId)) return fail(400, -32600, 'Duplicate active MCP request ID.');
        session.operations.set(requestId, controller);
    }
    clearTimeout(session.expiry);
    session.requests = (session.requests || 0) + 1;
    response.once('close', abort);
    const disconnected = () => { controller.abort(); response.destroy(); };
    signal.addEventListener('abort', disconnected, { once: true });
    try {
        await session.transport.handleRequest(request, response, body);
    } finally {
        controller.abort();
        response.removeListener('close', abort);
        signal.removeEventListener('abort', disconnected);
        if (requestId !== undefined) session.operations.delete(requestId);
        session.requests--;
        if (signal.aborted || request.method === 'DELETE' || !session.transport.sessionId) {
            sessions.delete(id);
            await session.server.close();
        } else if (!session.requests) {
            session.expiry = setTimeout(() => {
                sessions.delete(session.transport.sessionId);
                void session.server.close().catch(() => {});
            }, 30 * 60 * 1000);
            session.expiry.unref?.();
        }
    }
}

module.exports = { handleImageMcp };