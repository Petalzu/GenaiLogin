const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequestLifetime, waitForSignal, forwardBody, createBridgeAdmission, transportCode } = require('../bridge-stream');

test('admission bounds active requests and bytes, preserves FIFO and removes cancelled waiters', async () => {
	const gate = createBridgeAdmission({ maxActive: 2, maxQueued: 2, maxBytes: 10 });
	const signal = new AbortController().signal;
	const first = await gate.acquire(6, signal);
	const cancelled = new AbortController();
	const waiting = gate.acquire(5, cancelled.signal);
	const behind = gate.acquire(1, signal);
	assert.equal(gate.snapshot().active, 1);
	assert.equal(gate.snapshot().queued, 2);
	await assert.rejects(gate.acquire(1, signal), { code: 'BRIDGE_BUSY' });
	cancelled.abort();
	await assert.rejects(waiting, { name: 'AbortError' });
	const second = await behind;
	assert.equal(gate.snapshot().active, 2);
	assert.equal(gate.snapshot().reservedBytes, 7);
	first.release(); first.release(); second.release();
	assert.equal(gate.snapshot().active, 0);
	assert.equal(gate.snapshot().reservedBytes, 0);
	const blocked = new AbortController(); blocked.abort();
	assert.throws(() => gate.acquire(1, blocked.signal), { name: 'AbortError' });
	await assert.rejects(gate.acquire(11, signal), { code: 'BRIDGE_BUSY' });
});

test('admission shrinking releases only unused bytes and wakes queued requests in order', async () => {
	const gate = createBridgeAdmission({ maxActive: 3, maxBytes: 10 });
	const signal = new AbortController().signal;
	const first = await gate.acquire(10, signal);
	const waiting = gate.acquire(8, signal);
	first.shrink(2);
	const second = await waiting;
	assert.equal(gate.snapshot().active, 2);
	assert.equal(gate.snapshot().reservedBytes, 10);
	first.shrink(8); first.shrink(-1);
	assert.equal(gate.snapshot().reservedBytes, 10);
	first.release(); second.shrink(0);
	assert.equal(gate.snapshot().active, 1);
	assert.equal(gate.snapshot().reservedBytes, 0);
	second.release(); second.shrink(1);
	assert.equal(gate.snapshot().active, 0);
});

test('admission queue deadlines release waiters without cancelling active requests', async context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const gate = createBridgeAdmission({ maxActive: 1, maxQueued: 1, maxBytes: 10, queueTimeoutMs: 100 });
	const first = await gate.acquire(1, new AbortController().signal);
	const waiting = gate.acquire(1, new AbortController().signal);
	context.mock.timers.tick(101);
	await assert.rejects(waiting, { code: 'BRIDGE_QUEUE_TIMEOUT' });
	assert.equal(gate.snapshot().queued, 0);
	assert.equal(gate.snapshot().active, 1);
	first.release();
	const next = await gate.acquire(1, new AbortController().signal);
	next.release();
	assert.equal(gate.snapshot().reservedBytes, 0);
});

test('production network bundle preserves streaming, cookies and request cancellation', { timeout: 5000 }, async () => {
	const http = require('node:http');
	const { Agent, fetch } = require('../dist/upstream');
	const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
	let release;
	const server = http.createServer((request, response) => {
		response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'token=test; HttpOnly' });
		response.write('data: first\n\n');
		if (request.url === '/complete') release = () => response.end('data: [DONE]\n\n');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const endpoint = `http://127.0.0.1:${server.address().port}`;
	try {
		const result = await fetch(endpoint + '/complete', { dispatcher: agent });
		assert.deepEqual(result.headers.getSetCookie(), ['token=test; HttpOnly']);
		const reader = result.body.getReader();
		assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: first\n\n');
		release();
		assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: [DONE]\n\n');
		assert.equal((await reader.read()).done, true);
		reader.releaseLock();
		const controller = new AbortController();
		const cancelled = await fetch(endpoint + '/cancel', { dispatcher: agent, signal: controller.signal });
		const pending = cancelled.body.getReader();
		await pending.read();
		controller.abort();
		await assert.rejects(pending.read());
		pending.releaseLock();
	} finally {
		await agent.destroy();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { Agent, fetch } = require('undici');

test('already cancelled or closed connections release listeners immediately', () => {
	for (const closed of [false, true]) {
		const response = new EventEmitter();
		response.destroyed = closed;
		const parent = new AbortController();
		if (!closed) parent.abort();
		const lifetime = createRequestLifetime(response, parent.signal);
		assert.equal(lifetime.signal.aborted, true);
		assert.equal(response.listenerCount('close'), 0);
	}
});

test('HTTP delayed headers, silent body and large slow-consumed output preserve all bytes', { timeout: 20000 }, async () => {
	const payload = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '\u5206\u6790'.repeat(4096) } }] }) + '\n\n');
	const count = 256;
	const expected = createHash('sha256');
	for (let index = 0; index < count; index++) expected.update(payload);
	expected.update('data: [DONE]\n\n');
	let serverError;
	const server = http.createServer((request, response) => {
		(async () => {
			await delay(80);
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.flushHeaders();
			await delay(80);
			for (let index = 0; index < count; index++) {
				if (!response.write(payload)) await once(response, 'drain');
			}
			response.end('data: [DONE]\n\n');
		})().catch(error => { serverError = error; response.destroy(); });
	});
	const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const actual = createHash('sha256');
	const sink = new Writable({ highWaterMark: 1024, write(chunk, encoding, callback) {
		actual.update(chunk);
		setTimeout(callback, 1);
	} });
	const lifetime = createRequestLifetime(sink, new AbortController().signal);
	try {
		const result = await fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher, signal: lifetime.signal });
		await forwardBody(result.body, sink, lifetime, () => {}, true);
		assert.equal(actual.digest('hex'), expected.digest('hex'));
		assert.equal(serverError, undefined);
	} finally {
		lifetime.dispose();
		await dispatcher.destroy();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});

test('cancellation interrupts a silent upstream body and closes its socket', { timeout: 5000 }, async () => {
	let resolveClosed;
	const closed = new Promise(resolve => { resolveClosed = resolve; });
	const server = http.createServer((request, response) => {
		response.on('close', resolveClosed);
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.flushHeaders();
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
	const parent = new AbortController();
	const sink = new Writable({ write(chunk, encoding, callback) { callback(); } });
	const lifetime = createRequestLifetime(sink, parent.signal);
	try {
		const result = await fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher, signal: lifetime.signal });
		const forwarding = forwardBody(result.body, sink, lifetime, () => {}, true);
		parent.abort();
		await assert.rejects(forwarding, { name: 'AbortError' });
		await closed;
	} finally {
		lifetime.dispose();
		await dispatcher.destroy();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});
test('default idle timeout is disabled even during long silence', context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const response = new EventEmitter();
	const lifetime = createRequestLifetime(response, new AbortController().signal);
	context.mock.timers.tick(24 * 60 * 60 * 1000);
	assert.equal(lifetime.signal.aborted, false);
	response.emit('close');
	assert.equal(lifetime.signal.aborted, true);
	lifetime.dispose();
});

test('activity extends lifetime beyond the original deadline', async context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const response = new EventEmitter();
	const lifetime = createRequestLifetime(response, new AbortController().signal, 100);
	for (let index = 0; index < 10; index++) {
		context.mock.timers.tick(90);
		assert.equal(lifetime.signal.aborted, false);
		lifetime.touch();
	}
	context.mock.timers.tick(101);
	assert.equal(lifetime.signal.reason.name, 'TimeoutError');
	assert.equal(response.listenerCount('close'), 0);
});

test('client disconnect and parent cancellation abort upstream; disposal clears timer', context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	for (const action of ['client', 'parent', 'dispose']) {
		const response = new EventEmitter();
		const parent = new AbortController();
		const lifetime = createRequestLifetime(response, parent.signal, 100);
		if (action === 'client') response.emit('close');
		else if (action === 'parent') parent.abort();
		else lifetime.dispose();
		context.mock.timers.tick(101);
		assert.equal(lifetime.signal.aborted, action !== 'dispose');
		assert.equal(response.listenerCount('close'), 0);
	}
});

test('forwarding preserves bytes with a slow consumer', async () => {
	const chunks = [];
	const response = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
		chunks.push(chunk.toString());
		delay(2).then(() => callback());
	} });
	const body = new ReadableStream({ start(controller) {
		controller.enqueue(Buffer.from('data: first\n\n'));
		controller.enqueue(Buffer.from('data: [DONE]\n\n'));
		controller.close();
	} });
	let touches = 0;
	await forwardBody(body, response, { signal: new AbortController().signal, touch() { touches++; } }, () => {});
	assert.equal(chunks.join(''), 'data: first\n\ndata: [DONE]\n\n');
	assert.equal(touches, 2);
});

test('Markdown split across content deltas and empty reasoning fields stays unchanged', async () => {
	const { createUsageParser } = require('../stats');
	const fragments = ['v107 **84485528 >', ' 84485446**', ', +82.\n\n', '```js\nconst value = 1;\n```'];
	const events = fragments.map(content => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content, reasoning: '' } }] }) + '\n\n');
	const original = Buffer.from(events.join('') + 'data: [DONE]\n\n');
	const chunks = [];
	const response = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
	const parser = createUsageParser('text/event-stream', { committed: false });
	let offset = 0;
	const body = new ReadableStream({ pull(controller) {
		if (offset === original.length) controller.close();
		else controller.enqueue(original.subarray(offset, ++offset));
	} });
	await forwardBody(body, response, { signal: new AbortController().signal, touch() {} }, chunk => parser.consume(chunk));
	parser.finish();
	assert.deepEqual(Buffer.concat(chunks), original);
	const content = Buffer.concat(chunks).toString().split('\n\n').filter(event => event.startsWith('data: {'))
		.map(event => JSON.parse(event.slice(6)).choices[0].delta.content).join('');
	assert.equal(content, fragments.join(''));
});

test('formatting diagnostics distinguish actual newlines from reasoning interruptions', () => {
	const { createUsageParser } = require('../stats');
	const parser = createUsageParser('text/event-stream', { committed: false });
	const deltas = [
		{ index: 0, delta: { reasoning: 'Plan' } },
		{ index: 0, delta: { content: '\u73b0\u5728**84485528 >', reasoning: '' } },
		{ index: 1, delta: { reasoning: 'Separate choice' } },
		{ index: 0, delta: { content: ' 84485446**\n\n' } },
		{ index: 0, delta: { reasoning_content: 'Interruption' } },
		{ index: 0, delta: { content: '```js\nconst value = 1;\n```' } }
	];
	const bytes = Buffer.from(deltas.map(choice => 'data: ' + JSON.stringify({ choices: [choice] }) + '\r\n\r\n').join('') + 'data: [DONE]\n\n');
	for (const byte of bytes) parser.consume(Buffer.from([byte]));
	parser.finish();
	parser.finish();
	assert.deepEqual(parser.formatting, { contentChunks: 3, contentNewlines: 4, reasoningAfterContent: 1,
		mixedReasoningContent: 0, reasoningChunks: 3, toolCallChunks: 0, reasoningIdChunks: 0,
		parsedEvents: 6, invalidEvents: 0, droppedEvents: 0, eventStream: true });
});

test('formatting detects mixed first content, metadata-only thinking and skipped events', () => {
	const { createUsageParser, MAX_SSE_LINE_LENGTH } = require('../stats');
	const parser = createUsageParser('text/event-stream', { committed: false });
	const choices = [
		{ delta: { reasoning: 'Plan', content: 'First' } },
		{ delta: { content: ' next', signature: 'opaque' } },
		{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }
	];
	for (const choice of choices) parser.consume(Buffer.from('data: ' + JSON.stringify({ choices: [choice] }) + '\n\n'));
	parser.consume(Buffer.from(': heartbeat\n\ndata: invalid\n\ndata: ' + 'x'.repeat(MAX_SSE_LINE_LENGTH) + '\n\ndata: [DONE]\n\n'));
	parser.finish();
	assert.deepEqual(parser.formatting, { contentChunks: 2, contentNewlines: 0, reasoningAfterContent: 0,
		mixedReasoningContent: 1, reasoningChunks: 1, toolCallChunks: 1, reasoningIdChunks: 1,
		parsedEvents: 3, invalidEvents: 1, droppedEvents: 1, eventStream: true });
});

test('mixed reasoning is completed before the first Markdown fragment without duplicating tools or usage', async () => {
	const originalEvent = { id: 'chat-test', model: 'test', choices: [
		{ index: 0, delta: { role: 'assistant', reasoning: '\u601d\u8003', signature: 'sig', content: '**84485528 >', tool_calls: [{ index: 0, id: 'call', function: { name: 'test', arguments: '{}' } }] }, finish_reason: 'tool_calls' },
		{ index: 1, delta: { content: 'other' }, finish_reason: null }
	], usage: { completion_tokens: 12 } };
	const next = { choices: [{ index: 0, delta: { content: ' 84485446**\n\n' } }] };
	const input = Buffer.from(`data: ${JSON.stringify(originalEvent)}\r\n\r\ndata: ${JSON.stringify(next)}\n\ndata: [DONE]\n\n`);
	const output = [];
	let offset = 0;
	let observed = 0;
	const body = new ReadableStream({ pull(controller) {
		if (offset === input.length) controller.close();
		else controller.enqueue(input.subarray(offset, ++offset));
	} });
	const sink = new Writable({ write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
	await forwardBody(body, sink, { signal: new AbortController().signal, touch() {} }, chunk => { observed += chunk.length; }, true);
	assert.equal(observed, input.length);
	const result = Buffer.concat(output).toString();
	const events = result.split('\n\n').filter(event => event.startsWith('data: {')).map(event => JSON.parse(event.slice(6)));
	assert.equal(events.length, 3);
	assert.deepEqual(events[0].choices, [{ index: 0, delta: { reasoning: '\u601d\u8003', signature: 'sig', role: 'assistant' }, finish_reason: null }]);
	assert.equal(events[0].usage, undefined);
	const expected = structuredClone(originalEvent);
	delete expected.choices[0].delta.reasoning;
	delete expected.choices[0].delta.signature;
	delete expected.choices[0].delta.role;
	assert.deepEqual(events[1], expected);
	assert.deepEqual(events[2], next);
	const reported = [];
	let thinking = false;
	for (const event of events) {
		const delta = event.choices.find(choice => choice.index === 0)?.delta;
		if (delta.reasoning) { reported.push('thinking'); thinking = true; }
		else if (thinking) { reported.push('done'); thinking = false; }
		if (delta.content) reported.push(delta.content);
	}
	assert.deepEqual(reported, ['thinking', 'done', '**84485528 >', ' 84485446**\n\n']);
	assert.ok(result.endsWith('data: [DONE]\n\n'));
});

test('CR-only SSE boundaries split mixed events even across single-byte chunks', async () => {
	const event = { choices: [{ delta: { reasoning: 'plan', content: 'answer' } }] };
	const input = Buffer.from(`data: ${JSON.stringify(event)}\r\rdata: [DONE]\r\r`);
	const output = [];
	let offset = 0;
	const body = new ReadableStream({ pull(controller) {
		if (offset === input.length) controller.close();
		else controller.enqueue(input.subarray(offset, ++offset));
	} });
	const sink = new Writable({ write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
	await forwardBody(body, sink, { signal: new AbortController().signal, touch() {} }, () => {}, true);
	const text = Buffer.concat(output).toString();
	assert.equal((text.match(/data:/g) || []).length, 3);
	assert.ok(text.endsWith('data: [DONE]\r\r'));
	assert.deepEqual(text.split('\n\n').slice(0, 2).map(value => JSON.parse(value.slice(6)).choices[0].delta), [{ reasoning: 'plan' }, { content: 'answer' }]);
});

test('SSE metadata and metadata-only thinking cannot bypass separation', async () => {
	for (const field of ['cot_summary', 'reasoning_text', 'reasoning_content', 'reasoning', 'thinking', 'cot_id', 'reasoning_opaque', 'signature']) {
		const event = { choices: [{ index: 0, delta: { [field]: 'value', content: '正文' }, finish_reason: 'stop' }], usage: { completion_tokens: 1 } };
		const input = Buffer.from(': keepalive\r\nevent: message\r\nid: 123\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n');
		const output = [];
		const body = new ReadableStream({ start(controller) { controller.enqueue(input); controller.close(); } });
		const sink = new Writable({ write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
		await forwardBody(body, sink, { signal: new AbortController().signal, touch() {} }, () => {}, true);
		const events = Buffer.concat(output).toString().trim().split('\n\n');
		assert.equal(events.length, 2);
		for (const value of events) assert.ok(value.startsWith(': keepalive\nevent: message\nid: 123\n'));
		const parsed = events.map(value => JSON.parse(value.split('\n').find(line => line.startsWith('data:')).slice(5)));
		assert.deepEqual(parsed[0].choices[0].delta, { [field]: 'value' });
		assert.deepEqual(parsed[1].choices[0].delta, { content: '正文' });
		assert.equal(parsed[0].choices[0].finish_reason, null);
		assert.equal(parsed[0].usage, undefined);
		assert.equal(parsed[1].choices[0].finish_reason, 'stop');
	}
});

test('shared SSE decoding parses each event once and preserves usage and mixed reasoning diagnostics', async () => {
	const fs = require('node:fs');
	const vm = require('node:vm');
	const { createUsageParser } = require('../stats');
	let parses = 0;
	const sandbox = { module: { exports: {} }, require, Buffer, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout,
		JSON: { parse: text => { parses++; return JSON.parse(text); }, stringify: JSON.stringify } };
	vm.runInNewContext(fs.readFileSync(require.resolve('../bridge-stream'), 'utf8'), sandbox);
	const event = { choices: [{ index: 0, delta: { content: 'answer\n', reasoning: 'plan', tool_calls: [{ index: 0 }] } }],
		usage: { prompt_tokens: 10, completion_tokens: 2 } };
	const text = ': heartbeat\r\n\r\ndata: ' + JSON.stringify(event) + '\r\n\r\ndata: {"usage":{"completion_tokens":3}}\n\ndata: [DONE]\n\n';
	const bytes = Buffer.from(text);
	const state = { committed: false };
	const parser = createUsageParser('text/event-stream', state);
	const expectedState = { committed: false };
	const expected = createUsageParser('text/event-stream', expectedState);
	expected.consume(bytes); expected.finish();
	let offset = 0, observed = 0;
	const output = [];
	const body = new ReadableStream({ pull(controller) {
		if (offset === bytes.length) controller.close();
		else controller.enqueue(bytes.subarray(offset, ++offset));
	} });
	const sink = new Writable({ write(chunk, encoding, done) { output.push(chunk); done(); } });
	await sandbox.module.exports.forwardBody(body, sink, { signal: new AbortController().signal, touch() {} },
		chunk => { observed += chunk.length; }, true, parser.consumeEvent);
	parser.finish(); parser.finish();
	assert.equal(parses, 2);
	assert.equal(observed, bytes.length);
	assert.deepEqual(state, expectedState);
	assert.deepEqual(parser.formatting, expected.formatting);
	assert.equal(state.tokensOut, 3);
	assert.ok(Buffer.concat(output).toString().endsWith('data: [DONE]\n\n'));
});

test('shared SSE decoding handles CR-only and multiline data across UTF-8 byte boundaries', async () => {
	const { createUsageParser } = require('../stats');
	for (const newline of ['\r', '\r\n', '\n']) {
		const input = Buffer.from('event: message' + newline + 'data: {"choices":[{"delta":{"content":"\u4e2d\u6587"}}],' + newline +
			'data: "usage":{"prompt_tokens":13,"completion_tokens":7}}' + newline + newline + 'data: [DONE]' + newline + newline);
		let offset = 0;
		const state = { committed: false };
		const parser = createUsageParser('text/event-stream', state);
		const output = [];
		const body = new ReadableStream({ pull(controller) { if (offset === input.length) controller.close(); else controller.enqueue(input.subarray(offset, ++offset)); } });
		const sink = new Writable({ write(chunk, encoding, done) { output.push(chunk); done(); } });
		await forwardBody(body, sink, { signal: new AbortController().signal, touch() {} }, () => {}, true, parser.consumeEvent);
		parser.finish();
		assert.deepEqual(Buffer.concat(output), input);
		assert.equal(state.tokensIn, 13);
		assert.equal(state.tokensOut, 7);
		assert.equal(parser.formatting.parsedEvents, 1);
	}
});

test('shared SSE decoding retains a received usage event on upstream failure without completing the response', async () => {
	const { createUsageParser } = require('../stats');
	const state = { committed: false };
	const parser = createUsageParser('text/event-stream', state);
	let broken;
	const body = new ReadableStream({ start(controller) {
		controller.enqueue(Buffer.from('data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}'));
		broken = () => controller.error(new Error('fixture disconnect'));
	} });
	let observed;
	const consumed = new Promise(resolve => { observed = resolve; });
	const sink = new Writable({ write(chunk, encoding, done) { done(); } });
	const forwarding = forwardBody(body, sink, { signal: new AbortController().signal, touch() {} }, observed, true, parser.consumeEvent);
	await consumed; broken();
	await assert.rejects(forwarding, /fixture disconnect/);
	parser.finish();
	assert.equal(state.tokensIn, 7);
	assert.equal(state.tokensOut, 2);
	assert.equal(parser.formatting.parsedEvents, 1);
	assert.equal(sink.destroyed, true);
});

test('shared SSE decoding keeps usage size limits and preserves malformed or oversized bytes', async () => {
	const { createUsageParser, MAX_SSE_LINE_LENGTH } = require('../stats');
	const oversized = 'data: ' + JSON.stringify({ padding: 'x'.repeat(MAX_SSE_LINE_LENGTH), usage: { prompt_tokens: 9999 } }) + '\n\n';
	const input = Buffer.from(': heartbeat\n\n' + oversized + 'data: invalid\n\ndata: {"usage":{"prompt_tokens":7}}\n\ndata: [DONE]\n\n');
	const state = { committed: false };
	const parser = createUsageParser('text/event-stream', state);
	const chunks = [];
	const sink = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
	const body = new ReadableStream({ start(controller) { controller.enqueue(input); controller.close(); } });
	await forwardBody(body, sink, { signal: new AbortController().signal, touch() {} }, () => {}, true, parser.consumeEvent);
	parser.finish();
	assert.deepEqual(Buffer.concat(chunks), input);
	assert.equal(state.tokensIn, 7);
	assert.equal(parser.formatting.parsedEvents, 1);
	assert.equal(parser.formatting.invalidEvents, 1);
	assert.equal(parser.formatting.droppedEvents, 1);
});

test('normalization preserves ordinary, oversized, malformed and incomplete events byte for byte', async () => {
	const ordinary = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '\u4e2d\u6587\n```js\n```', reasoning: '' } }] }) + '\r\n\r\n';
	const input = Buffer.from(': heartbeat\n\n' + ordinary + 'data: invalid\n\n' + 'data: ' + 'x'.repeat(1024 * 1024 + 1) + '\n\n' + ordinary + 'data: [DONE]\n\ndata: unfinished');
	const output = [];
	let offset = 0;
	const body = new ReadableStream({ pull(controller) {
		if (offset === input.length) controller.close();
		else { controller.enqueue(input.subarray(offset, offset + 137)); offset = Math.min(input.length, offset + 137); }
	} });
	const sink = new Writable({ write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
	await forwardBody(body, sink, { signal: new AbortController().signal, touch() {} }, () => {}, true);
	assert.deepEqual(Buffer.concat(output), input);
});

test('upstream failures reject instead of becoming successful truncated responses', async () => {
	const response = new Writable({ write(chunk, encoding, callback) { callback(); } });
	const body = new ReadableStream({ start(controller) { controller.error(new Error('terminated')); } });
	await assert.rejects(forwardBody(body, response, { signal: new AbortController().signal, touch() {} }, () => {}), /terminated/);
	assert.equal(response.destroyed, true);
	assert.equal(transportCode({ cause: { code: 'UND_ERR_SOCKET' } }), 'UND_ERR_SOCKET');
	assert.equal(transportCode(new DOMException('Check timed out', 'TimeoutError')), 'TimeoutError');
	assert.equal(transportCode(new DOMException('Cancelled', 'AbortError')), 'AbortError');
	assert.equal(transportCode({ code: 23, cause: { code: 'ECONNRESET' }, name: 'TimeoutError' }), 'ECONNRESET');
	assert.equal(transportCode({ name: 'secret value' }), 'UNKNOWN');
});

test('single-byte UTF-8 fragments preserve SSE and intentional newlines exactly', async () => {
	const text = '\u4e2d\u6587\u5206\u6790\n\n```js\nconst value = 1;\n```';
	const original = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\r\n\r\ndata: [DONE]\n\n');
	const chunks = [];
	const response = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
	let offset = 0;
	const body = new ReadableStream({ pull(controller) {
		if (offset === original.length) controller.close();
		else controller.enqueue(original.subarray(offset, ++offset));
	} });
	await forwardBody(body, response, { signal: new AbortController().signal, touch() {} }, () => {});
	assert.deepEqual(Buffer.concat(chunks), original);
	assert.equal(JSON.parse(Buffer.concat(chunks).toString().split('\r\n')[0].slice(6)).choices[0].delta.content, text);
});
test('request cancellation stops waiting without cancelling shared authentication', async () => {
	let finish;
	const shared = new Promise(resolve => { finish = resolve; });
	const parent = new AbortController();
	const waiting = waitForSignal(shared, parent.signal);
	parent.abort();
	await assert.rejects(waiting, { name: 'AbortError' });
	finish('authenticated');
	assert.equal(await shared, 'authenticated');
	assert.equal(await waitForSignal(Promise.resolve('ready'), new AbortController().signal), 'ready');
});
test('idle timeout starts only after authentication and can pause during reauthentication', context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const response = new EventEmitter();
	const lifetime = createRequestLifetime(response, new AbortController().signal);
	context.mock.timers.tick(180000);
	assert.equal(lifetime.signal.aborted, false);
	lifetime.setIdleTimeout(100);
	context.mock.timers.tick(90);
	lifetime.setIdleTimeout(0);
	context.mock.timers.tick(180000);
	assert.equal(lifetime.signal.aborted, false);
	lifetime.setIdleTimeout(100);
	context.mock.timers.tick(101);
	assert.equal(lifetime.signal.reason.name, 'TimeoutError');
});