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

function splitMixedEvent(bytes) {
	const lines = bytes.toString('utf8').split(/\r\n|\r|\n/).filter(Boolean);
	const dataLines = lines.filter(line => line.startsWith('data:'));
	if (!dataLines.length) return bytes;
	const metadata = lines.filter(line => !line.startsWith('data:')).join('\n');
	const prefix = metadata ? metadata + '\n' : '';
	let event;
	try { event = JSON.parse(dataLines.map(line => line.slice(5).replace(/^ /, '')).join('\n')); } catch { return bytes; }
	if (!Array.isArray(event?.choices)) return bytes;
	const thinkingChoices = [];
	const choices = event.choices.map(choice => {
		const delta = choice?.delta;
		if (typeof delta?.content !== 'string' || !delta.content || ![...reasoningFields, ...reasoningMetadata].some(field => typeof delta[field] === 'string' && delta[field])) return choice;
		const thinking = {};
		const content = { ...delta };
		for (const field of [...reasoningFields, ...reasoningMetadata, 'role']) {
			if (Object.hasOwn(delta, field)) { thinking[field] = delta[field]; delete content[field]; }
		}
		thinkingChoices.push({ index: choice.index ?? 0, delta: thinking, finish_reason: null });
		return { ...choice, delta: content };
	});
	if (!thinkingChoices.length) return bytes;
	const first = { ...event, choices: thinkingChoices };
	delete first.usage;
	return Buffer.from(`${prefix}data: ${JSON.stringify(first)}\n\n${prefix}data: ${JSON.stringify({ ...event, choices })}\n\n`);
}

function createMixedReasoningTransform() {
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
				if (!passthrough) this.push(splitMixedEvent(Buffer.concat(parts, size)));
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
			if (pendingBoundary && !passthrough) this.push(splitMixedEvent(Buffer.concat(parts, size)));
			else for (const part of parts) this.push(part);
			callback();
		}
	});
}

async function forwardBody(body, response, lifetime, consume, normalizeMixedReasoning = false) {
	const { Readable, Transform } = require('node:stream');
	const { pipeline } = require('node:stream/promises');
	const monitor = new Transform({
		transform(chunk, encoding, callback) {
			lifetime.touch();
			try { consume(chunk); callback(null, chunk); } catch (error) { callback(error); }
		}
	});
	const streams = [Readable.fromWeb(body), monitor];
	if (normalizeMixedReasoning) streams.push(createMixedReasoningTransform());
	await pipeline(...streams, response, { signal: lifetime.signal });
}

function transportCode(error) {
	return [error?.cause?.code, error?.code, error?.name].find(code =>
		typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code)) || 'UNKNOWN';
}

module.exports = { createRequestLifetime, waitForSignal, forwardBody, transportCode };