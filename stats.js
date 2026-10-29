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
	const pricing = request.model === DEEPSEEK_PRICING.model || request.model === 'DeepSeek-V4.1-Flash-1017' ? DEEPSEEK_PRICING :
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
		costMin: timedCost, costMax: timedCost,
		timedReports: timed ? 1 : 0, peakCost: peak ? timedCost : 0, offPeakCost: !peak ? timedCost : 0 }]);
}

const historyStores = new WeakMap();
const HISTORY_FIELDS = ['requests', 'tokensIn', 'tokensOut', 'inputUsageReports', 'outputUsageReports'];

function summarizeHistory(records) {
	const total = Object.fromEntries(HISTORY_FIELDS.map(field => [field, 0]));
	const models = new Map();
	for (const record of records) {
		for (const field of HISTORY_FIELDS) {
			if (Number.isSafeInteger(record?.[field]) && record[field] >= 0) total[field] += record[field];
		}
		mergeModelUsage(models, record?.modelUsage);
	}
	return { ...total, ...(models.size ? { modelUsage: modelUsageRows(models) } : {}) };
}

function createHistoryFiles(fileSystem, directory, joinPath, onError = () => {}) {
	let ready;
	let cacheTimer, cacheLegacy;
	let cachePending = Promise.resolve();
	const cacheName = 'usageHistory.total.v1.json';
	const validRecord = record => record && typeof record === 'object' && !Array.isArray(record) &&
		(record.modelUsage === undefined || Array.isArray(record.modelUsage));
	const signature = async name => {
		const info = await fileSystem.stat(joinPath(directory, name));
		return JSON.stringify([info.mtime, info.ctime, info.size]);
	};
	const readRecord = async name => {
		const bytes = await fileSystem.readFile(joinPath(directory, name));
		const record = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
		if (!validRecord(record)) throw new Error('Invalid usage record');
		return record;
	};
	const summarizedRecords = (records, windowTotal, excludedKey) => [['usageHistory.total.v1',
		records.some(record => record.name === excludedKey + '.json') ?
			summarizeHistory(records.filter(record => record.name !== excludedKey + '.json').map(record => record.value)) : windowTotal]];
	const ensureDirectory = () => ready ??= fileSystem.createDirectory(directory).catch(error => { ready = undefined; throw error; });
	const flushCache = () => {
		if (cacheTimer) {
			clearTimeout(cacheTimer);
			cacheTimer = undefined;
			cachePending = cachePending.then(() => store.read(undefined, cacheLegacy)).then(() => {}, onError);
		}
		return cachePending;
	};
	const store = {
		async read(excludedKey, legacy, onCached = () => {}) {
			let cached;
			try {
				const candidate = await readRecord(cacheName);
				if (candidate.version === 1 && Array.isArray(candidate.records) && validRecord(candidate.windowTotal) && validRecord(candidate.total) &&
					candidate.records.every(record => typeof record.name === 'string' && /^usageHistory\.window\.v3\.[0-9a-f-]+\.json$/.test(record.name) &&
						typeof record.signature === 'string' && validRecord(record.value)) &&
					new Set(candidate.records.map(record => record.name)).size === candidate.records.length) cached = candidate;
			} catch {}
			if (cached) onCached(summarizedRecords(cached.records, cached.windowTotal, excludedKey));
			await ensureDirectory();
			const entries = await fileSystem.readDirectory(directory);
			const names = entries.map(([name]) => name).filter(name => /^usageHistory\.window\.v3\.[0-9a-f-]+\.json$/.test(name)).sort();
			if (!fileSystem.stat) {
				return (await Promise.all(names.map(async name => {
					try { return [name.slice(0, -5), await readRecord(name)]; }
					catch { onError(); return undefined; }
				}))).filter(Boolean);
			}
			const previous = new Map(cached?.records.map(record => [record.name, record]));
			let cacheable = true;
			const records = (await Promise.all(names.map(async name => {
				try {
					const current = await signature(name);
					const saved = previous.get(name);
					if (saved?.signature === current) return saved;
					const value = await readRecord(name);
					if (await signature(name) !== current) cacheable = false;
					return { name, signature: current, value };
				} catch { cacheable = false; onError(); return undefined; }
			}))).filter(Boolean);
			const unchanged = cacheable && cached && records.length === previous.size && records.every(record => previous.get(record.name) === record);
			const windowTotal = unchanged ? cached.windowTotal : summarizeHistory(records.map(record => record.value));
			if (!cached) onCached(summarizedRecords(records, windowTotal, excludedKey));
			const legacyJson = JSON.stringify(legacy ?? null);
			if (cacheable && (!unchanged || cached.legacy !== legacyJson)) {
				const temporary = joinPath(directory, cacheName + '.' + require('node:crypto').randomUUID() + '.tmp');
				try {
					await fileSystem.writeFile(temporary, Buffer.from(JSON.stringify({ version: 1, legacy: legacyJson,
						total: summarizeHistory([legacy, windowTotal]), windowTotal, records })));
					for (let attempt = 0; ; attempt++) {
						try { await fileSystem.rename(temporary, joinPath(directory, cacheName), { overwrite: true }); break; }
						catch (error) {
							if (attempt >= 2 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
							await require('node:timers/promises').setTimeout(10 * (attempt + 1));
						}
					}
				} catch (error) { await fileSystem.delete?.(temporary, { useTrash: false }).catch(() => {}); onError(error); }
			}
			return summarizedRecords(records, windowTotal, excludedKey);
		},
		async update(key, value, legacy) {
			await ensureDirectory();
			const temporary = joinPath(directory, key + '.tmp');
			const destination = joinPath(directory, key + '.json');
			await fileSystem.writeFile(temporary, Buffer.from(JSON.stringify(value)));
			await fileSystem.rename(temporary, destination, { overwrite: true });
			if (fileSystem.stat) {
				cacheLegacy = legacy;
				if (!cacheTimer) { cacheTimer = setTimeout(flushCache, 1000); cacheTimer.unref?.(); }
			}
		},
		flush: flushCache
	};
	return store;
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
		let base = shared.baseCache;
		if (!shared.recordStore || !base || shared.legacy !== legacy || stored.length) {
			base = summarizeHistory([legacy, ...[...shared.records].filter(([key]) => key !== shared.key).map(([, value]) => value), ...stored]);
			if (shared.recordStore && !stored.length) shared.baseCache = base;
		}
		const value = (base.modelUsage?.length || 0) + models.size > MAX_TRACKED_MODELS ?
			summarizeHistory([deltaSnapshot(), legacy, ...[...shared.records].filter(([key]) => key !== shared.key).map(([, record]) => record), ...stored]) :
			summarizeHistory([deltaSnapshot(), base]);
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
				try { await (shared.recordStore || storage).update(shared.key, value, storage.get(legacyKey)); } catch { onError(); }
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
		state: () => !shared.recordStore || shared.loaded ? 'ready' : shared.failed ? 'error' : 'loading',
		reload(onCached = () => {}) {
			if (!shared.recordStore) return Promise.resolve();
			if (!shared.loading) {
				const applyRecords = records => {
					shared.records = new Map(records);
					shared.baseCache = undefined;
					shared.snapshotCache = undefined;
					shared.loaded = true;
					shared.failed = false;
				};
				shared.loading = shared.recordStore.read(shared.key, storage.get(legacyKey), records => {
					if (!shared.loaded) { applyRecords(records); onCached(); }
				}).then(applyRecords).catch(error => { shared.failed = true; onError(error); }).finally(() => { shared.loading = undefined; });
			}
			return shared.loading;
		},
		async flush() { await shared.pending; await shared.recordStore?.flush?.(); }
	};
}
const MAX_TRACKED_MODELS = 64;
const MAX_SSE_LINE_LENGTH = 64 * 1024;
const MAX_JSON_STATS_BODY = 2 * 1024 * 1024;
const MAX_JSON_REQUEST_BODY = 20 * 1024 * 1024;

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

function parseRequestBody(body) {
	if (!body || body.length > MAX_JSON_REQUEST_BODY) return undefined;
	try { return JSON.parse(body.toString('utf8')); } catch { return undefined; }
}

function recordRequest(stats, body, startedAt = Date.now(), parsedBody) {
	if (body === undefined) return undefined;
	stats.requests++;
	let model = 'unknown';
	if (body.length <= MAX_JSON_REQUEST_BODY) {
		const parsed = arguments.length >= 4 ? parsedBody : parseRequestBody(body);
		if (typeof parsed?.model === 'string' && parsed.model.length <= 256 && parsed.model.trim()) model = parsed.model;
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
	const consumeEvent = (event, { dropped = false, invalid = false, dataLength = 0, lineLength = 0 } = {}) => {
		if (finished || !requestStats) return;
		if (dropped || dataLength + 1 > MAX_SSE_LINE_LENGTH || lineLength > MAX_SSE_LINE_LENGTH) { formatting.droppedEvents++; return; }
		if (invalid) { formatting.invalidEvents++; return; }
		try {
			formatting.parsedEvents++;
			applyUsage(requestStats, event.usage);
			for (const choice of Array.isArray(event.choices) ? event.choices : []) {
				const delta = choice?.delta;
				if (!delta) continue;
				const index = choice.index ?? 0;
				const hasReasoning = typeof delta.cot_summary === 'string' && delta.cot_summary.length > 0 ||
					typeof delta.reasoning_text === 'string' && delta.reasoning_text.length > 0 ||
					typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0 ||
					typeof delta.reasoning === 'string' && delta.reasoning.length > 0 ||
					typeof delta.thinking === 'string' && delta.thinking.length > 0;
				if (hasReasoning) formatting.reasoningChunks++;
				if (contentChoices.has(index) && hasReasoning) formatting.reasoningAfterContent++;
				if (delta.cot_id || delta.reasoning_opaque || delta.signature) formatting.reasoningIdChunks++;
				if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) formatting.toolCallChunks++;
				if (typeof delta.content === 'string' && delta.content.length > 0) {
					if (hasReasoning) formatting.mixedReasoningContent++;
					formatting.contentChunks++;
					for (let newline = delta.content.indexOf('\n'); newline >= 0; newline = delta.content.indexOf('\n', newline + 1)) formatting.contentNewlines++;
					if (contentChoices.size < 128) contentChoices.add(index);
				}
			}
		} catch { formatting.invalidEvents++; }
	};
	const flushEvent = () => {
		if (droppingEvent) consumeEvent(undefined, { dropped: true });
		const data = eventData.trim();
		if (!droppingEvent && data && data !== '[DONE]') {
			try { consumeEvent(JSON.parse(eventData)); } catch { consumeEvent(undefined, { invalid: true }); }
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
		consumeEvent,
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
			if (isEventStream) {
				consumeEventStream(decoder.end());
				if (lineBuffer && !droppingLine) processLine(lineBuffer);
				flushEvent();
				lineBuffer = '';
				finished = true;
				return;
			}
			if (jsonBuffer !== null) {
				jsonBuffer += decoder.end();
				try { applyUsage(requestStats, JSON.parse(jsonBuffer).usage); } catch {}
			}
			jsonBuffer = '';
			finished = true;
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
	MAX_JSON_REQUEST_BODY,
	createStats,
	parseRequestBody,
	recordRequest,
	applyUsage,
	commitRequest,
	createUsageParser
};