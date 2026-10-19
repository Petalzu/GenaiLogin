const { StringDecoder } = require('node:string_decoder');
const modelPricing = require('./model-pricing.json');

const DEEPSEEK_PRICING = Object.freeze({
	model: 'DeepSeek-V4.1-Flash', currency: 'USD', checkedAt: '2026-10-08',
	source: 'https://api-docs.deepseek.com/quick_start/pricing',
	input: 0.15, cached: 0.003, output: 0.6, peakMultiplier: 2
});
const MODEL_FIELDS = ['requests', 'tokensIn', 'tokensOut', 'inputUsageReports', 'outputUsageReports',
	'cachedTokens', 'cacheInputTokens', 'cacheReports', 'pricedReports', 'costMin', 'costMax',
	'timedReports', 'peakCost', 'offPeakCost'];

function isPeakTime(timestamp) {
	const date = new Date(timestamp);
	const day = date.getUTCDay();
	const hour = date.getUTCHours();
	return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function mergeModelUsage(target, rows) {
	for (const row of rows || []) {
		if (!row || typeof row.name !== 'string') continue;
		const name = target.has(row.name) || target.size < MAX_TRACKED_MODELS ? row.name : '其他模型';
		const total = target.get(name) || Object.fromEntries(MODEL_FIELDS.map(field => [field, 0]));
		for (const field of MODEL_FIELDS) {
			if (Number.isFinite(row[field]) && row[field] >= 0) total[field] += row[field];
		}
		target.set(name, total);
	}
}

function modelUsageRows(models) {
	return [...models].map(([name, usage]) => ({ name, ...usage }));
}

function recordModelUsage(models, request) {
	if (!request.model) return;
	if (request.hasInput && !(Number.isSafeInteger(request.cachedTokens) && request.cachedTokens >= 0 && request.cachedTokens <= request.tokensIn)) {
		request = { ...request, cachedTokens: Math.round(request.tokensIn * 0.9) };
	}
	const cacheKnown = request.hasInput && Number.isSafeInteger(request.cachedTokens) &&
		request.cachedTokens >= 0 && request.cachedTokens <= request.tokensIn;
	const pricing = request.model === DEEPSEEK_PRICING.model ? DEEPSEEK_PRICING :
		Object.hasOwn(modelPricing.models, request.model) ? modelPricing.models[request.model] : undefined;
	const priced = Boolean(pricing && cacheKnown && request.hasOutput);
	const currencyDivisor = pricing?.currency === 'CNY' ? modelPricing.exchangeRate.CNYPerUSD : 1;
	const cost = priced ? ((request.tokensIn - request.cachedTokens) * pricing.input +
		request.cachedTokens * (pricing.cached ?? pricing.input) + request.tokensOut * pricing.output) / 1e6 / currencyDivisor : 0;
	const multiplier = pricing?.peakMultiplier ?? 1;
	const timed = priced && (multiplier === 1 || (Number.isFinite(request.startedAt) && Number.isFinite(new Date(request.startedAt).getTime())));
	const peak = timed && multiplier > 1 && isPeakTime(request.startedAt);
	const timedCost = cost * (peak ? multiplier : 1);
	mergeModelUsage(models, [{ name: request.model, requests: 1,
		tokensIn: request.hasInput ? request.tokensIn : 0, tokensOut: request.hasOutput ? request.tokensOut : 0,
		inputUsageReports: request.hasInput ? 1 : 0, outputUsageReports: request.hasOutput ? 1 : 0,
		cachedTokens: cacheKnown ? request.cachedTokens : 0, cacheInputTokens: cacheKnown ? request.tokensIn : 0,
		cacheReports: cacheKnown ? 1 : 0, pricedReports: priced ? 1 : 0,
		costMin: timed ? timedCost : cost, costMax: timed ? timedCost : cost * multiplier,
		timedReports: timed ? 1 : 0, peakCost: peak ? timedCost : 0, offPeakCost: timed && !peak ? timedCost : 0 }]);
}

const historyStores = new WeakMap();

function createHistoryFiles(fileSystem, directory, joinPath, onError = () => {}) {
	let ready;
	const ensureDirectory = () => ready ??= fileSystem.createDirectory(directory).catch(error => { ready = undefined; throw error; });
	return {
		async read() {
			await ensureDirectory();
			const entries = await fileSystem.readDirectory(directory);
			const records = await Promise.all(entries.filter(([name]) => /^usageHistory\.window\.v3\.[0-9a-f-]+\.json$/.test(name)).map(async ([name]) => {
				try {
					const record = JSON.parse(Buffer.from(await fileSystem.readFile(joinPath(directory, name))).toString('utf8'));
					if (!record || typeof record !== 'object' || (record.modelUsage !== undefined && !Array.isArray(record.modelUsage))) throw new Error('Invalid usage record');
					return [name.slice(0, -5), record];
				} catch { onError(); return undefined; }
			}));
			return records.filter(Boolean);
		},
		async update(key, value) {
			await ensureDirectory();
			const temporary = joinPath(directory, key + '.tmp');
			const destination = joinPath(directory, key + '.json');
			await fileSystem.writeFile(temporary, Buffer.from(JSON.stringify(value)));
			await fileSystem.rename(temporary, destination, { overwrite: true });
		}
	};
}

function createHistory(storage, onError = () => {}, recordStore) {
	const legacyKey = 'usageHistory.summary.v2';
	const prefix = 'usageHistory.window.v3.';
	let shared = historyStores.get(storage);
	if (!shared) {
		const total = { requests: 0, tokensIn: 0, tokensOut: 0, inputUsageReports: 0, outputUsageReports: 0 };
		const models = new Map();
		shared = { total, models, key: prefix + require('node:crypto').randomUUID(), pending: Promise.resolve(), saving: false, records: new Map(), recordStore };
		historyStores.set(storage, shared);
	}
	const { total, models } = shared;
	const deltaSnapshot = () => ({ ...total, ...(models.size ? { modelUsage: modelUsageRows(models) } : {}) });
	const copySnapshot = value => ({ ...value, ...(value.modelUsage ? { modelUsage: value.modelUsage.map(row => ({ ...row })) } : {}) });
	const snapshot = () => {
		const legacy = storage.get(legacyKey);
		const stored = (storage.keys?.() || []).filter(key => key.startsWith(prefix) && key !== shared.key).map(key => storage.get(key));
		if (shared.recordStore && shared.snapshotCache && shared.legacy === legacy && !stored.length) return copySnapshot(shared.snapshotCache);
		const result = { ...total };
		const combined = new Map();
		mergeModelUsage(combined, modelUsageRows(models));
		const records = [legacy, ...[...shared.records].filter(([key]) => key !== shared.key).map(([, value]) => value), ...stored];
		for (const record of records) {
			for (const field of Object.keys(total)) {
				if (Number.isSafeInteger(record?.[field]) && record[field] >= 0) result[field] += record[field];
			}
			mergeModelUsage(combined, record?.modelUsage);
		}
		const value = { ...result, ...(combined.size ? { modelUsage: modelUsageRows(combined) } : {}) };
		if (shared.recordStore && !stored.length) { shared.snapshotCache = value; shared.legacy = legacy; }
		return copySnapshot(value);
	};
	const save = () => {
		shared.requested = deltaSnapshot();
		if (shared.saving) return;
		shared.saving = true;
		shared.pending = shared.pending.then(async () => {
			while (shared.requested) {
				const value = shared.requested; shared.requested = undefined;
				try { await (shared.recordStore || storage).update(shared.key, value); } catch { onError(); }
			}
		}).finally(() => { shared.saving = false; });
	};
	return {
		start() { total.requests++; shared.snapshotCache = undefined; save(); },
		finish(request) {
			if (!request || request.historyCommitted) return;
			request.historyCommitted = true;
			shared.snapshotCache = undefined;
			if (request.hasInput) { total.tokensIn += request.tokensIn; total.inputUsageReports++; }
			if (request.hasOutput) { total.tokensOut += request.tokensOut; total.outputUsageReports++; }
			recordModelUsage(models, request);
			save();
		},
		snapshot,
		reload() {
			if (!shared.recordStore) return Promise.resolve();
			if (!shared.loading) shared.loading = shared.recordStore.read().then(records => {
				shared.records = new Map(records);
				shared.snapshotCache = undefined;
			}).catch(onError).finally(() => { shared.loading = undefined; });
			return shared.loading;
		},
		flush: () => shared.pending
	};
}
const MAX_TRACKED_MODELS = 64;
const MAX_SSE_LINE_LENGTH = 64 * 1024;
const MAX_JSON_STATS_BODY = 2 * 1024 * 1024;

function createStats(port) {
	return {
		port,
		connectedAt: null,
		requests: 0,
		tokensIn: 0,
		tokensOut: 0,
		usageReports: 0,
		usageMissing: 0,
		inputUsageReports: 0,
		outputUsageReports: 0,
		models: new Map(),
		modelUsage: new Map(),
		otherModels: 0
	};
}

function recordRequest(stats, body, startedAt = Date.now()) {
	if (body === undefined) return undefined;
	stats.requests++;
	let model = 'unknown';
	if (body.length <= MAX_JSON_STATS_BODY) {
		try {
			const parsed = JSON.parse(body.toString('utf8'));
			if (typeof parsed.model === 'string' && parsed.model.length <= 256 && parsed.model) model = parsed.model;
		} catch { model = 'unknown'; }
	}
	const current = stats.models.get(model);
	if (current !== undefined) stats.models.set(model, current + 1);
	else if (stats.models.size < MAX_TRACKED_MODELS) stats.models.set(model, 1);
	else stats.otherModels++;
	return { model, startedAt, hasUsage: false, hasInput: false, hasOutput: false, tokensIn: 0, tokensOut: 0, committed: false };
}

function applyUsage(requestStats, usage) {
	if (!usage || !requestStats || requestStats.committed) return;
	const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
	if (Number.isSafeInteger(cached) && cached >= 0) requestStats.cachedTokens = cached;
	const tokensIn = Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null;
	const tokensOut = Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null;
	if (tokensIn === null && tokensOut === null) return;
	requestStats.hasUsage = true;
	if (tokensIn !== null) { requestStats.tokensIn = tokensIn; requestStats.hasInput = true; }
	if (tokensOut !== null) { requestStats.tokensOut = tokensOut; requestStats.hasOutput = true; }
}

function commitRequest(stats, requestStats) {
	if (!requestStats || requestStats.committed) return false;
	requestStats.committed = true;
	recordModelUsage(stats.modelUsage, requestStats);
	if (requestStats.hasUsage) {
		stats.usageReports++;
		stats.tokensIn += requestStats.tokensIn;
		stats.tokensOut += requestStats.tokensOut;
		if (requestStats.hasInput) stats.inputUsageReports++;
		if (requestStats.hasOutput) stats.outputUsageReports++;
	} else stats.usageMissing++;
	return true;
}

function createUsageParser(contentType, requestStats) {
	const isEventStream = contentType.toLowerCase().includes('text/event-stream');
	const formatting = { contentChunks: 0, contentNewlines: 0, reasoningAfterContent: 0,
		mixedReasoningContent: 0, reasoningChunks: 0, toolCallChunks: 0, reasoningIdChunks: 0,
		parsedEvents: 0, invalidEvents: 0, droppedEvents: 0, eventStream: isEventStream };
	const contentChoices = new Set();
	let lineBuffer = '';
	let jsonBuffer = '';
	let finished = false;
	const decoder = new StringDecoder('utf8');
	let droppingLine = false;
	let eventData = '';
	let droppingEvent = false;
	const flushEvent = () => {
		if (droppingEvent) formatting.droppedEvents++;
		if (!droppingEvent && eventData.trim() && eventData.trim() !== '[DONE]') {
			try {
				const event = JSON.parse(eventData);
				formatting.parsedEvents++;
				applyUsage(requestStats, event.usage);
				for (const choice of Array.isArray(event.choices) ? event.choices : []) {
					const delta = choice?.delta;
					if (!delta) continue;
					const index = choice.index ?? 0;
					const hasReasoning = [delta.cot_summary, delta.reasoning_text, delta.reasoning_content, delta.reasoning, delta.thinking].some(value => typeof value === 'string' && value.length > 0);
					if (hasReasoning) formatting.reasoningChunks++;
					if (contentChoices.has(index) && hasReasoning) formatting.reasoningAfterContent++;
					if (delta.cot_id || delta.reasoning_opaque || delta.signature) formatting.reasoningIdChunks++;
					if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) formatting.toolCallChunks++;
					if (typeof delta.content === 'string' && delta.content.length > 0) {
						if (hasReasoning) formatting.mixedReasoningContent++;
						formatting.contentChunks++;
						formatting.contentNewlines += (delta.content.match(/\n/g) || []).length;
						if (contentChoices.size < 128) contentChoices.add(index);
					}
				}
			} catch { formatting.invalidEvents++; }
		}
		eventData = '';
		droppingEvent = false;
	};

	const processLine = line => {
		const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
		if (!normalized) { flushEvent(); return; }
		if (!normalized.startsWith('data:') || normalized.length > MAX_SSE_LINE_LENGTH) return;
		const data = normalized.slice(5).replace(/^ /, '');
		if (droppingEvent) return;
		if (eventData.length + data.length + 1 > MAX_SSE_LINE_LENGTH) { droppingEvent = true; eventData = ''; return; }
		eventData += (eventData ? '\n' : '') + data;
	};

	const consumeEventStream = text => {
		let offset = 0;
		while (offset < text.length) {
			const newline = text.indexOf('\n', offset);
			if (newline < 0) {
				const remaining = text.slice(offset);
				if (!droppingLine) {
					if (lineBuffer.length + remaining.length <= MAX_SSE_LINE_LENGTH) lineBuffer += remaining;
					else { lineBuffer = ''; droppingLine = true; droppingEvent = true; }
				}
				return;
			}
			const segment = text.slice(offset, newline);
			if (!droppingLine && lineBuffer.length + segment.length <= MAX_SSE_LINE_LENGTH) processLine(lineBuffer + segment);
			else droppingEvent = true;
			droppingLine = false;
			lineBuffer = '';
			offset = newline + 1;
		}
	};

	return {
		formatting,
		consume(chunk) {
			if (finished || !requestStats) return;
			const text = decoder.write(chunk);
			if (isEventStream) {
				consumeEventStream(text);
				return;
			}
			if (jsonBuffer !== null) {
				jsonBuffer = jsonBuffer.length + text.length <= MAX_JSON_STATS_BODY ? jsonBuffer + text : null;
			}
		},
		finish() {
			if (finished || !requestStats) return;
			finished = true;
			if (isEventStream) {
				consumeEventStream(decoder.end());
				if (lineBuffer && !droppingLine) processLine(lineBuffer);
				flushEvent();
				lineBuffer = '';
				return;
			}
			if (jsonBuffer !== null) {
				jsonBuffer += decoder.end();
				try { applyUsage(requestStats, JSON.parse(jsonBuffer).usage); } catch {}
			}
			jsonBuffer = '';
		}
	};
}

module.exports = {
	DEEPSEEK_PRICING,
	modelUsageRows,
	createHistory,
	createHistoryFiles,
	MAX_TRACKED_MODELS,
	MAX_SSE_LINE_LENGTH,
	MAX_JSON_STATS_BODY,
	createStats,
	recordRequest,
	applyUsage,
	commitRequest,
	createUsageParser
};