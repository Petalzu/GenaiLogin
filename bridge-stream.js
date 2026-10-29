function createRequestLifetime(response, parentSignal, idleMs = 0) {
	const controller = new AbortController();
	const signal = AbortSignal.any([parentSignal, controller.signal]);
	let timer;
	let disposed = false;
	const touch = () => {
		clearTimeout(timer);
		if (disposed || signal.aborted || idleMs === 0) return;
		timer = setTimeout(() => controller.abort(new DOMException('Upstream idle timeout', 'TimeoutError')), idleMs);
		timer.unref?.();
	};
	const cancel = () => {
		if (!response.writableFinished) controller.abort(new DOMException('Client disconnected', 'AbortError'));
	};
	const dispose = () => {
		disposed = true;
		clearTimeout(timer);
		response.off('close', cancel);
		signal.removeEventListener('abort', dispose);
	};
	response.once('close', cancel);
	signal.addEventListener('abort', dispose, { once: true });
	if (response.destroyed) cancel();
	if (signal.aborted) dispose();
	touch();
	return { signal, touch, dispose, setIdleTimeout: milliseconds => { idleMs = milliseconds; touch(); } };
}

function waitForSignal(promise, signal) {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
		signal.addEventListener('abort', aborted, { once: true });
		Promise.resolve(promise).then(value => {
			signal.removeEventListener('abort', aborted); resolve(value);
		}, error => {
			signal.removeEventListener('abort', aborted); reject(error);
		});
		if (signal.aborted) aborted();
	});
}

const reasoningFields = ['cot_summary', 'reasoning_text', 'reasoning_content', 'reasoning', 'thinking'];
const reasoningMetadata = ['cot_id', 'reasoning_opaque', 'signature'];
const thinkingFields = [...reasoningFields, ...reasoningMetadata];
const separatedFields = [...thinkingFields, 'role'];

function splitMixedEvent(bytes, onEvent, normalize = true) {
	const lines = bytes.toString('utf8').split(/\r\n|\r|\n/).filter(Boolean);
	const dataLines = lines.filter(line => line.startsWith('data:'));
	const lineLength = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
	if (!dataLines.length) { if (lineLength > 64 * 1024) onEvent?.(undefined, { dropped: true }); return bytes; }
	const data = dataLines.map(line => line.slice(line[5] === ' ' ? 6 : 5)).join('\n');
	if (!data.trim() || data.trim() === '[DONE]') return bytes;
	let event;
	try { event = JSON.parse(data); }
	catch { onEvent?.(undefined, { invalid: true, dataLength: data.length, lineLength }); return bytes; }
	onEvent?.(event, { dataLength: data.length, lineLength });
	if (!normalize || !Array.isArray(event?.choices)) return bytes;
	const thinkingChoices = [];
	let choices;
	for (let index = 0; index < event.choices.length; index++) {
		const choice = event.choices[index];
		const delta = choice?.delta;
		if (typeof delta?.content !== 'string' || !delta.content || !thinkingFields.some(field => typeof delta[field] === 'string' && delta[field])) continue;
		const thinking = {};
		const content = { ...delta };
		for (const field of separatedFields) {
			if (Object.hasOwn(delta, field)) { thinking[field] = delta[field]; delete content[field]; }
		}
		thinkingChoices.push({ index: choice.index ?? 0, delta: thinking, finish_reason: null });
		choices ??= event.choices.slice();
		choices[index] = { ...choice, delta: content };
	}
	if (!choices) return bytes;
	const metadata = lines.filter(line => !line.startsWith('data:')).join('\n');
	const prefix = metadata ? metadata + '\n' : '';
	const first = { ...event, choices: thinkingChoices };
	delete first.usage;
	return Buffer.from(`${prefix}data: ${JSON.stringify(first)}\n\n${prefix}data: ${JSON.stringify({ ...event, choices })}\n\n`);
}

function createMixedReasoningTransform(onEvent) {
	const { Transform } = require('node:stream');
	let parts = [];
	let size = 0;
	let passthrough = false;
	let lineLength = 0;
	let pendingCR = false;
	let pendingBoundary = false;
	const limit = 1024 * 1024;
	return new Transform({
		transform(chunk, encoding, callback) {
			const append = bytes => {
				if (!bytes.length) return;
				if (!passthrough && size + bytes.length > limit) {
					for (const part of parts) this.push(part);
					parts = []; size = 0; passthrough = true;
				}
				if (passthrough) this.push(bytes);
				else { parts.push(bytes); size += bytes.length; }
			};
			let start = 0;
			const finish = () => {
				if (!passthrough) this.push(splitMixedEvent(parts.length === 1 ? parts[0] : Buffer.concat(parts, size), onEvent));
				else onEvent?.(undefined, { dropped: true });
				parts = []; size = 0; passthrough = false;
			};
			for (let offset = 0; offset < chunk.length; offset++) {
				const byte = chunk[offset];
				if (pendingCR) {
					pendingCR = false;
					if (pendingBoundary) {
						const end = byte === 10 ? offset + 1 : offset;
						append(chunk.subarray(start, end)); finish(); start = end;
						pendingBoundary = false;
					}
					if (byte === 10) continue;
				}
				if (byte === 13 || byte === 10) {
					const boundary = lineLength === 0;
					lineLength = 0;
					if (byte === 13) { pendingCR = true; pendingBoundary = boundary; }
					else if (boundary) {
						append(chunk.subarray(start, offset + 1));
						finish(); start = offset + 1;
					}
				} else lineLength++;
			}
			append(chunk.subarray(start));
			callback();
		},
		flush(callback) {
			if (parts.length && !passthrough) this.push(splitMixedEvent(parts.length === 1 ? parts[0] : Buffer.concat(parts, size), onEvent, pendingBoundary));
			else { if (passthrough) onEvent?.(undefined, { dropped: true }); for (const part of parts) this.push(part); }
			parts = []; size = 0; passthrough = false;
			callback();
		},
		destroy(error, callback) {
			if (parts.length && !passthrough) splitMixedEvent(parts.length === 1 ? parts[0] : Buffer.concat(parts, size), onEvent, false);
			else if (passthrough) onEvent?.(undefined, { dropped: true });
			parts = []; size = 0; passthrough = false;
			callback(error);
		}
	});
}

async function forwardBody(body, response, lifetime, consume, normalizeMixedReasoning = false, onEvent) {
	const { Readable, Transform } = require('node:stream');
	const { pipeline } = require('node:stream/promises');
	const monitor = new Transform({
		transform(chunk, encoding, callback) {
			lifetime.touch();
			try { consume(chunk); callback(null, chunk); } catch (error) { callback(error); }
		}
	});
	const streams = [Readable.fromWeb(body), monitor];
	if (normalizeMixedReasoning) streams.push(createMixedReasoningTransform(onEvent));
	await pipeline(...streams, response, { signal: lifetime.signal });
}

function createBridgeAdmission({ maxActive = 32, maxQueued = 64, maxBytes = 128 * 1024 * 1024, queueTimeoutMs = 60000 } = {}) {
	let active = 0, reservedBytes = 0;
	const queue = [];
	const busy = code => Object.assign(new Error(code === 'BRIDGE_QUEUE_TIMEOUT' ? 'GENAI bridge queue timed out; retry later.' : 'GENAI bridge is busy; retry later.'), { code });
	const drain = () => {
		while (queue.length && active < maxActive && reservedBytes + queue[0].bytes <= maxBytes) queue.shift().grant();
	};
	return {
		acquire(bytes, signal) {
			signal.throwIfAborted();
			if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) return Promise.reject(busy('BRIDGE_BUSY'));
			return new Promise((resolve, reject) => {
				let timer;
				const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
				const remove = error => {
					const index = queue.indexOf(entry);
					if (index < 0) return;
					queue.splice(index, 1); cleanup(); reject(error); drain();
				};
				const abort = () => remove(signal.reason);
				const entry = { bytes, grant() {
					cleanup(); active++; reservedBytes += bytes;
					let released = false, retained = bytes;
					resolve({ bytes, shrink(value) {
						if (released || !Number.isSafeInteger(value) || value < 0 || value >= retained) return;
						reservedBytes -= retained - value; retained = value; drain();
					}, release() {
						if (released) return;
						released = true; active--; reservedBytes -= retained; drain();
					} });
				} };
				if (!queue.length && active < maxActive && reservedBytes + bytes <= maxBytes) return entry.grant();
				if (queue.length >= maxQueued) return reject(busy('BRIDGE_BUSY'));
				queue.push(entry);
				signal.addEventListener('abort', abort, { once: true });
				timer = setTimeout(() => remove(busy('BRIDGE_QUEUE_TIMEOUT')), queueTimeoutMs);
				timer.unref?.();
				if (signal.aborted) abort();
			});
		},
		snapshot: () => ({ active, queued: queue.length, reservedBytes, maxActive, maxQueued, maxBytes })
	};
}

function proxyResponseHeaders(headers, contentType = headers.get('content-type') || 'application/json') {
	const result = { 'content-type': contentType };
	for (const name of ['retry-after', 'retry-after-ms', 'x-request-id', 'request-id', 'x-correlation-id']) {
		const value = headers.get(name);
		if (value) result[name] = value;
	}
	return result;
}

function transportCode(error) {
	return [error?.cause?.code, error?.code, error?.name].find(code =>
		typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code)) || 'UNKNOWN';
}

module.exports = { createRequestLifetime, waitForSignal, forwardBody, createBridgeAdmission, proxyResponseHeaders, transportCode };