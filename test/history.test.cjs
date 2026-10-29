const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, createHistoryFiles } = require('../stats');
const { createStats, recordRequest, applyUsage, commitRequest, createUsageParser } = require('../stats');

function historyFileHarness() {
	const files = new Map();
	const versions = new Map();
	const reads = [];
	const set = (name, value) => {
		files.set(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
		versions.set(name, (versions.get(name) || 0) + 1);
	};
	const adapter = {
		createDirectory: async () => {},
		readDirectory: async () => [...files.keys()].map(name => [name, 1]),
		stat: async name => ({ mtime: versions.get(name), ctime: 1, size: files.get(name).length }),
		readFile: async name => { reads.push(name); return files.get(name); },
		writeFile: async (name, bytes) => set(name, bytes),
		rename: async (source, target) => { set(target, files.get(source)); files.delete(source); }
	};
	return { files, reads, adapter, set,
		store: () => createHistoryFiles(adapter, '', (directory, name) => name, () => assert.fail('unexpected storage error')) };
}

test('final stream cache usage settles once and persists model costs', async () => {
	const stats = createStats(58379);
	const request = recordRequest(stats, Buffer.from('{"model":"DeepSeek-V4.1-Flash"}'), Date.parse('2026-10-08T00:00:00Z'));
	const parser = createUsageParser('text/event-stream', request);
	parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":1000,"completion_tokens":1}}\n\n'));
	parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":800}}}\n\n'));
	parser.finish();
	commitRequest(stats, request);
	commitRequest(stats, request);
	const usage = stats.modelUsage.get(request.model);
	assert.equal(usage.requests, 1);
	assert.equal(usage.cachedTokens, 800);
	assert.equal(usage.cacheInputTokens, 1000);
	assert.equal(usage.pricedReports, 1);
	assert.ok(Math.abs(usage.costMin - 0.0000924) < 1e-12);
	assert.equal(usage.costMax, usage.costMin);
	assert.equal(usage.offPeakCost, usage.costMin);
	assert.equal(usage.timedReports, 1);
	const records = new Map();
	const storage = { keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => records.set(key, value) };
	const history = createHistory(storage);
	history.start(); history.finish(request); history.finish(request);
	await history.flush();
	assert.deepEqual(createHistory(storage).snapshot().modelUsage, [{ name: request.model, ...usage }]);
});

test('stream diagnostics preserve reasoning variants, metadata and newline counts across chunk boundaries', () => {
	const request = recordRequest(createStats(58379), Buffer.from('{"model":"sample"}'));
	const parser = createUsageParser('text/event-stream', request);
	const deltas = [{ content: 'first\nsecond\n' }, { reasoning: 'analysis' },
		{ cot_summary: 'summary', content: 'third\n' }, { reasoning_text: 'analysis' },
		{ reasoning_content: 'analysis' }, { thinking: 'analysis', cot_id: 'id' },
		{ reasoning: 123, content: '', tool_calls: [{}] }];
	const bytes = Buffer.from(deltas.map(delta => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n').join('') +
		'data: {"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\ndata: [DONE]\n\n');
	for (let offset = 0; offset < bytes.length; offset += 11) parser.consume(bytes.subarray(offset, offset + 11));
	parser.finish(); parser.finish();
	assert.deepEqual(parser.formatting, { contentChunks: 2, contentNewlines: 3, reasoningAfterContent: 5,
		mixedReasoningContent: 1, reasoningChunks: 5, toolCallChunks: 1, reasoningIdChunks: 1,
		parsedEvents: 8, invalidEvents: 0, droppedEvents: 0, eventStream: true });
	assert.equal(request.tokensIn, 100);
	assert.equal(request.tokensOut, 10);
});

test('pricing uses request start UTC boundaries, weekdays and no holiday exceptions', () => {
	for (const [time, multiplier] of [
		['2026-10-08T00:59:59Z', 1], ['2026-10-08T01:00:00Z', 2],
		['2026-10-08T03:59:59Z', 2], ['2026-10-08T04:00:00Z', 1],
		['2026-10-08T05:59:59Z', 1], ['2026-10-08T06:00:00Z', 2],
		['2026-10-08T09:59:59Z', 2], ['2026-10-08T10:00:00Z', 1],
		['2026-10-10T02:00:00Z', 1], ['2026-10-11T07:00:00Z', 1],
		['2026-10-01T02:00:00Z', 2], ['2026-10-09T09:00:00+08:00', 2]
	]) {
		const stats = createStats(58379);
		const request = recordRequest(stats, Buffer.from('{"model":"DeepSeek-V4.1-Flash"}'), Date.parse(time));
		applyUsage(request, { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 0 });
		commitRequest(stats, request);
		const usage = stats.modelUsage.get(request.model);
		assert.equal(usage.costMin, 0.75 * multiplier, time);
		assert.equal(usage.costMax, usage.costMin, time);
		assert.equal(usage.peakCost, multiplier === 2 ? 1.5 : 0, time);
		assert.equal(usage.offPeakCost, multiplier === 1 ? 0.75 : 0, time);
	}
});

test('large chat requests retain their model and pricing', () => {
	const stats = createStats(58379);
	const body = Buffer.from(JSON.stringify({ model: 'DeepSeek-V4.1-Flash', messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] }));
	const request = recordRequest(stats, body, Date.parse('2026-10-08T00:00:00Z'));
	assert.equal(request.model, 'DeepSeek-V4.1-Flash');
	applyUsage(request, { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 900000 });
	commitRequest(stats, request);
	assert.equal(stats.models.has('unknown'), false);
	assert.equal(stats.modelUsage.get(request.model).pricedReports, 1);
});

test('DeepSeek 1017 uses the original model rates and peak schedule', () => {
	for (const [time, expected] of [['2026-10-08T00:00:00Z', 0.6177], ['2026-10-08T02:00:00Z', 1.2354]]) {
		const stats = createStats(58379);
		for (const model of ['DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash-1017']) {
			const request = recordRequest(stats, Buffer.from(JSON.stringify({ model })), Date.parse(time));
			applyUsage(request, { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 900000 });
			commitRequest(stats, request);
			const usage = stats.modelUsage.get(model);
			assert.equal(usage.pricedReports, 1, model);
			assert.ok(Math.abs(usage.costMin - expected) < 1e-12, model);
			assert.equal(usage.costMax, usage.costMin, model);
		}
	}
});

test('missing request timestamps use off-peak pricing without a range', () => {
	const stats = createStats(58379);
	const request = recordRequest(stats, Buffer.from('{"model":"DeepSeek-V4.1-Flash-1017"}'));
	delete request.startedAt;
	applyUsage(request, { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 900000 });
	commitRequest(stats, request);
	const usage = stats.modelUsage.get(request.model);
	assert.ok(Math.abs(usage.costMin - 0.6177) < 1e-12);
	assert.equal(usage.costMax, usage.costMin);
	assert.equal(usage.timedReports, 0);
	assert.equal(usage.offPeakCost, usage.costMin);
});

test('preparsed request metadata avoids decoding the body twice including invalid JSON', () => {
	const { parseRequestBody } = require('../stats');
	for (const text of ['{"model":"DeepSeek-V4.1-Flash-1017"}', '{}', 'null', '{']) {
		const body = Buffer.from(text);
		let decodes = 0;
		body.toString = (...args) => { decodes++; return Buffer.prototype.toString.apply(body, args); };
		const parsed = parseRequestBody(body);
		const request = recordRequest(createStats(58379), body, 0, parsed);
		assert.equal(decodes, 1);
		assert.equal(request.model, parsed?.model || 'unknown');
	}
});

test('requests with missing or invalid models remain unknown without throwing', () => {
	const stats = createStats(58379);
	for (const body of ['{}', 'null', '[]', '{', '{"model":false}', '{"model":""}', '{"model":" "}', '{"model":"unknown"}']) {
		const request = recordRequest(stats, Buffer.from(body));
		assert.equal(request.model, 'unknown', body);
		applyUsage(request, { prompt_tokens: 100, completion_tokens: 10 });
		commitRequest(stats, request);
	}
	assert.equal(stats.requests, 8);
	assert.equal(stats.models.get('unknown'), 8);
	assert.equal(stats.modelUsage.get('unknown').tokensIn, 800);
	assert.equal(stats.modelUsage.get('unknown').tokensOut, 80);
});

test('saved historical peak price is read unchanged without activation writes', async () => {
	const saved = { modelUsage: [{ name: 'DeepSeek-V4.1-Flash', tokensIn: 1000000, tokensOut: 1000000, cachedTokens: 900000, inputUsageReports: 1, outputUsageReports: 1, pricedReports: 1, timedReports: 1, costMin: 16.964512, costMax: 16.964512, peakCost: 16.964512 }] };
	let writes = 0;
	const history = createHistory({ get: key => key === 'usageHistory.summary.v2' ? saved : undefined, update: async () => { writes++; } });
	await history.flush();
	assert.equal(writes, 0);
	const usage = history.snapshot().modelUsage[0];
	assert.equal(usage.cachedTokens, 900000);
	assert.equal(usage.costMin, 16.964512);
	assert.equal(usage.costMax, usage.costMin);
	assert.equal(usage.timedReports, 1);
	assert.equal(usage.peakCost, usage.costMin);
});

test('missing and invalid cache use 90 percent while valid cache remains actual', () => {
	const stats = createStats(58379);
	for (const cached of [undefined, -1, 101, 0, 50]) {
		const request = recordRequest(stats, Buffer.from('{"model":"DeepSeek-V4.1-Flash"}'));
		applyUsage(request, { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: cached });
		commitRequest(stats, request);
	}
	const usage = stats.modelUsage.get('DeepSeek-V4.1-Flash');
	assert.equal(usage.requests, 5);
	assert.equal(usage.tokensIn, 500);
	assert.equal(usage.cacheReports, 5);
	assert.equal(usage.cacheInputTokens, 500);
	assert.equal(usage.cachedTokens, 320);
	assert.equal(usage.pricedReports, 5);
	const other = recordRequest(stats, Buffer.from('{"model":"other"}'));
	applyUsage(other, { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } });
	commitRequest(stats, other);
	assert.equal(stats.modelUsage.get('other').pricedReports, 0);
});

test('history shares one in-process accumulator and settles once', async () => {
	const records = new Map();
	const storage = { keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => { records.set(key, value); } };
	const first = createHistory(storage);
	const second = createHistory(storage);
	first.start(); second.start(); first.start();
	const request = { hasInput: true, hasOutput: true, tokensIn: 12, tokensOut: 30 };
	first.finish(request); first.finish(request);
	second.finish({ hasInput: true, tokensIn: 5 });
	await Promise.all([first.flush(), second.flush()]);
	assert.deepEqual(createHistory(storage).snapshot(), { requests: 3, tokensIn: 17, tokensOut: 30, inputUsageReports: 2, outputUsageReports: 1 });
	assert.equal(first.snapshot().requests, 3);
});

test('failed persistence is reported and does not poison later updates', async () => {
	let updates = 0, errors = 0;
	const history = createHistory({ keys: () => [], get() {}, update: async () => { if (++updates === 1) throw Error('disk'); } }, () => { errors++; });
	history.start(); await history.flush(); history.start(); await history.flush();
	assert.equal(errors, 1);
	assert.equal(updates, 2);
	assert.equal(history.snapshot().requests, 2);
});

test('published model rates price cache, flat input and CNY conversion independently', () => {
	for (const [model, expected] of [
		['gemma-4-31B-it', 0.394], ['gpt-oss-120b', 0.207],
		['Qwen3.8-27B', 2.669], ['Qwen3.5-397B-A17B', 3.243],
		['GLM-5.3-Flash', 0.542], ['GLM-OCR', 0.4 / 6.711932]
	]) {
		for (const time of ['2026-10-08T02:00:00Z', '2026-10-08T12:00:00Z']) {
			const stats = createStats(58379);
			const request = recordRequest(stats, Buffer.from(JSON.stringify({ model })), Date.parse(time));
			applyUsage(request, { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 900000 });
			commitRequest(stats, request);
			const usage = stats.modelUsage.get(model);
			assert.equal(usage.pricedReports, 1, model);
			assert.ok(Math.abs(usage.costMin - expected) < 1e-12, model);
			assert.equal(usage.costMax, usage.costMin, model);
		}
	}
});

test('summary survives fresh storage reload without rewriting', async () => {
	const legacy = { requests: 1495, tokensIn: 383062746, tokensOut: 2451141, inputUsageReports: 1495, outputUsageReports: 1495 };
	const records = new Map([['usageHistory.summary.v2', legacy]]);
	const storage = () => ({ keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => {
		if (value === undefined) records.delete(key);
		else records.set(key, value);
	} });
	const history = createHistory(storage());
	await history.flush();
	assert.deepEqual([...records.keys()], ['usageHistory.summary.v2']);
	const saved = records.get('usageHistory.summary.v2');
	assert.equal(saved.backfill, undefined);
	assert.equal(saved.tokensIn + saved.tokensOut, 385513887);
	assert.deepEqual(saved, legacy);
	assert.deepEqual(createHistory(storage()).snapshot(), saved);
});

test('independent windows cannot overwrite history with their stale snapshots', async () => {
	const legacy = { requests: 10, tokensIn: 100, tokensOut: 200, inputUsageReports: 1, outputUsageReports: 1 };
	const disk = new Map([['usageHistory.summary.v2', legacy]]);
	const storage = () => {
		const cache = new Map(disk);
		return { keys: () => [...cache.keys()], get: key => cache.get(key), update: async (key, value) => {
			cache.set(key, value); disk.set(key, value);
		} };
	};
	const firstWindow = createHistory(storage());
	const secondWindow = createHistory(storage());
	firstWindow.start(); firstWindow.finish({ model: 'sample', hasInput: true, tokensIn: 7 });
	await firstWindow.flush();
	secondWindow.start(); secondWindow.finish({ model: 'sample', hasOutput: true, tokensOut: 9 });
	await secondWindow.flush();
	const reloaded = createHistory(storage()).snapshot();
	assert.equal(reloaded.requests, 12);
	assert.equal(reloaded.tokensIn, 107);
	assert.equal(reloaded.tokensOut, 209);
	assert.equal(reloaded.modelUsage[0].requests, 2);
	assert.equal(reloaded.modelUsage[0].tokensIn, 7);
	assert.equal(reloaded.modelUsage[0].tokensOut, 9);
	assert.deepEqual(disk.get('usageHistory.summary.v2'), legacy);
	assert.equal([...disk.keys()].filter(key => key.startsWith('usageHistory.window.v3.')).length, 2);
});

test('history observes peer records and coalesces queued writes without double counting', async () => {
	const records = new Map();
	const releases = [];
	let writes = 0;
	const storage = { keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => {
		writes++;
		await new Promise(resolve => releases.push(resolve));
		records.set(key, value);
	} };
	const history = createHistory(storage);
	history.start(); history.start();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(writes, 1);
	history.start(); history.start(); history.start();
	releases.shift()();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(writes, 2);
	releases.shift()(); await history.flush();
	records.set('usageHistory.window.v3.peer', { requests: 3, tokensIn: 12 });
	assert.equal(history.snapshot().requests, 8);
	assert.equal(history.snapshot().tokensIn, 12);
	assert.equal(createHistory({ ...storage }).snapshot().requests, 8);
});

test('independent history files survive whole-object Memento overwrites', async () => {
	const files = new Map();
	const joins = (directory, name) => directory + '/' + name;
	const fileSystem = {
		createDirectory: async () => {},
		readDirectory: async directory => [...files.keys()].filter(path => path.startsWith(directory + '/')).map(path => [path.slice(directory.length + 1), 1]),
		readFile: async path => files.get(path),
		writeFile: async (path, bytes) => { files.set(path, bytes); },
		rename: async (source, target) => { files.set(target, files.get(source)); files.delete(source); }
	};
	const legacy = { requests: 10, tokensIn: 100 };
	const storage = () => ({ get: key => key === 'usageHistory.summary.v2' ? legacy : undefined, keys: () => ['usageHistory.summary.v2'],
		update: () => assert.fail('new usage must not overwrite the shared Memento') });
	const first = createHistory(storage(), () => assert.fail('unexpected storage error'), createHistoryFiles(fileSystem, '/history', joins));
	const second = createHistory(storage(), () => assert.fail('unexpected storage error'), createHistoryFiles(fileSystem, '/history', joins));
	await Promise.all([first.reload(), second.reload()]);
	first.start(); second.start();
	await Promise.all([first.flush(), second.flush()]);
	assert.equal(files.size, 2);
	assert.ok([...files.keys()].every(path => path.endsWith('.json')));
	await first.reload(); await second.reload();
	assert.equal(first.snapshot().requests, 12);
	assert.equal(second.snapshot().requests, 12);
	const reloaded = createHistory(storage(), () => assert.fail('unexpected reload error'), createHistoryFiles(fileSystem, '/history', joins));
	await reloaded.reload();
	assert.equal(reloaded.snapshot().requests, 12);
	assert.equal(reloaded.snapshot().tokensIn, 100);
});

test('history files persist atomically across fresh stores on disk', async () => {
	const fileSystem = require('node:fs/promises');
	const { join } = require('node:path');
	const { tmpdir } = require('node:os');
	const directory = await fileSystem.mkdtemp(join(tmpdir(), 'genai-history-'));
	const adapter = { createDirectory: path => fileSystem.mkdir(path, { recursive: true }),
		readDirectory: async path => (await fileSystem.readdir(path)).map(name => [name, 1]),
		stat: async path => { const info = await fileSystem.stat(path); return { mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size }; },
		readFile: path => fileSystem.readFile(path), writeFile: (path, bytes) => fileSystem.writeFile(path, bytes),
		delete: path => fileSystem.rm(path, { force: true }),
		rename: (source, target) => fileSystem.rename(source, target) };
	const storage = () => ({ get() {}, keys: () => [], update: () => assert.fail('Memento must remain unchanged') });
	try {
		const first = createHistory(storage(), () => assert.fail('write failed'), createHistoryFiles(adapter, directory, join));
		const second = createHistory(storage(), () => assert.fail('write failed'), createHistoryFiles(adapter, directory, join));
		first.start(); second.start();
		await Promise.all([first.flush(), second.flush()]);
		first.start(); await first.flush();
		const restored = createHistory(storage(), () => assert.fail('read failed'), createHistoryFiles(adapter, directory, join));
		await restored.reload();
		assert.equal(restored.snapshot().requests, 3);
		assert.equal(JSON.parse(await fileSystem.readFile(join(directory, 'usageHistory.total.v1.json'))).total.requests, 3);
		assert.equal((await fileSystem.readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
	} finally { await fileSystem.rm(directory, { recursive: true, force: true }); }
});

test('history totals persist in one validated cache without rereading unchanged window files', async () => {
	const files = new Map([
		['/history/usageHistory.window.v3.1111.json', Buffer.from('{"requests":3,"tokensIn":20}')],
		['/history/usageHistory.window.v3.2222.json', Buffer.from('{"requests":4,"tokensOut":9}')]
	]);
	const reads = [];
	const adapter = {
		createDirectory: async () => {},
		readDirectory: async () => [...files.keys()].map(name => [name.slice('/history/'.length), 1]),
		stat: async name => ({ mtime: 1, ctime: 1, size: files.get(name).length }),
		readFile: async name => { reads.push(name); return files.get(name); },
		writeFile: async (name, bytes) => { files.set(name, bytes); },
		rename: async (source, target) => { files.set(target, files.get(source)); files.delete(source); }
	};
	const storage = () => ({ get() {}, keys: () => [] });
	const store = () => createHistoryFiles(adapter, '/history', (directory, name) => directory + '/' + name,
		() => assert.fail('healthy history must remain readable'));
	const first = createHistory(storage(), () => assert.fail('reload failed'), store());
	await first.reload();
	assert.equal(first.snapshot().requests, 7);
	const cached = JSON.parse(files.get('/history/usageHistory.total.v1.json'));
	assert.equal(cached.total.requests, 7);
	assert.equal(cached.total.tokensIn, 20);
	assert.equal(cached.total.tokensOut, 9);
	reads.length = 0;
	const restored = createHistory(storage(), () => assert.fail('reload failed'), store());
	await restored.reload();
	assert.deepEqual(restored.snapshot(), first.snapshot());
	assert.equal(reads.filter(name => /usageHistory\.window\./.test(name)).length, 0);
	assert.equal(files.size, 3);
});

test('cached total appears before slow directory validation and only changed windows are reread', async () => {
	const harness = historyFileHarness();
	const legacy = { requests: 10, tokensIn: 100, tokensOut: 1 };
	const storage = () => ({ get: key => key === 'usageHistory.summary.v2' ? legacy : undefined, keys: () => [] });
	harness.set('usageHistory.window.v3.1111.json', { requests: 3, tokensIn: 20 });
	await createHistory(storage(), () => assert.fail('reload failed'), harness.store()).reload();
	assert.equal(JSON.parse(harness.files.get('usageHistory.total.v1.json')).total.requests, 13);
	harness.set('usageHistory.window.v3.1111.json', { requests: 4, tokensIn: 30 });
	harness.set('usageHistory.window.v3.2222.json', { requests: 2, tokensOut: 9 });
	const list = harness.adapter.readDirectory;
	let release;
	harness.adapter.readDirectory = async () => { await new Promise(resolve => { release = resolve; }); return list(); };
	const history = createHistory(storage(), () => assert.fail('reload failed'), harness.store());
	assert.equal(history.state(), 'loading');
	let cached;
	const loading = history.reload(() => { cached = history.snapshot(); });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(cached.requests, 13);
	assert.equal(cached.tokensIn, 120);
	assert.equal(history.state(), 'ready');
	release(); await loading;
	assert.equal(history.snapshot().requests, 16);
	assert.equal(history.snapshot().tokensIn, 130);
	assert.equal(history.snapshot().tokensOut, 10);
	harness.adapter.readDirectory = list;
	harness.reads.length = 0;
	harness.set('usageHistory.window.v3.2222.json', { requests: 3, tokensOut: 8 });
	await harness.store().read();
	assert.deepEqual(harness.reads.filter(name => name.startsWith('usageHistory.window.')), ['usageHistory.window.v3.2222.json']);
});

test('stale concurrent total writes never overwrite window usage and recover without duplicate accumulation', async () => {
	const harness = historyFileHarness();
	const storage = () => ({ get() {}, keys: () => [] });
	const first = createHistory(storage(), () => assert.fail('first window failed'), harness.store());
	const second = createHistory(storage(), () => assert.fail('second window failed'), harness.store());
	first.start();
	first.finish({ model: 'DeepSeek-V4.1-Flash', hasInput: true, tokensIn: 1000, hasOutput: true, tokensOut: 10, cachedTokens: 900 });
	await first.flush();
	const rename = harness.adapter.rename;
	let release, reached;
	const paused = new Promise(resolve => { reached = resolve; });
	let hold = true;
	harness.adapter.rename = async (source, target) => {
		if (target === 'usageHistory.total.v1.json' && hold) {
			hold = false; reached();
			await new Promise(resolve => { release = resolve; });
		}
		return rename(source, target);
	};
	harness.files.delete('usageHistory.total.v1.json');
	const pending = first.reload();
	await paused;
	second.start();
	second.finish({ model: 'DeepSeek-V4.1-Flash', hasInput: true, tokensIn: 2000, hasOutput: true, tokensOut: 20, cachedTokens: 1800 });
	await second.flush();
	await second.reload();
	assert.equal(second.snapshot().requests, 2);
	release(); await pending;
	assert.equal(JSON.parse(harness.files.get('usageHistory.total.v1.json')).total.requests, 1);
	const restored = createHistory(storage(), () => assert.fail('recovery failed'), harness.store());
	await restored.reload();
	await Promise.all([first.reload(), second.reload()]);
	for (const history of [first, second, restored]) {
		const total = history.snapshot();
		assert.equal(total.requests, 2);
		assert.equal(total.tokensIn, 3000);
		assert.equal(total.tokensOut, 30);
		assert.equal(total.modelUsage[0].cachedTokens, 2700);
		assert.equal(total.modelUsage[0].requests, 2);
		assert.ok(Math.abs(total.modelUsage[0].costMin - 0.0000711) < 1e-12);
	}
	assert.equal([...harness.files.keys()].filter(name => name.endsWith('.tmp')).length, 0);
});

test('history decoding respects Uint8Array offsets without copying unrelated bytes', async () => {
	const harness = historyFileHarness();
	harness.set('usageHistory.window.v3.1111.json', { requests: 3, tokensIn: 50 });
	const read = harness.adapter.readFile;
	harness.adapter.readFile = async name => {
		const bytes = await read(name);
		if (!bytes) throw new Error('missing cache');
		const padded = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
		return new Uint8Array(padded.buffer, padded.byteOffset + 6, bytes.byteLength);
	};
	const history = createHistory({ get() {}, keys: () => [] }, () => assert.fail('reload failed'), harness.store());
	await history.reload();
	assert.equal(history.snapshot().requests, 3);
	assert.equal(history.snapshot().tokensIn, 50);
});

test('invalid total caches rebuild without rewriting historical records or prices', async () => {
	for (const cache of [Buffer.from('damaged'), { version: 99 }, { version: 1, records: [], windowTotal: null, total: {} }]) {
		const harness = historyFileHarness();
		const value = { requests: 3, tokensIn: 50, modelUsage: [{ name: 'DeepSeek-V4.1-Flash', costMin: 12, costMax: 12, pricedReports: 1 }] };
		harness.set('usageHistory.window.v3.1111.json', value);
		const original = harness.files.get('usageHistory.window.v3.1111.json');
		harness.set('usageHistory.total.v1.json', cache);
		const history = createHistory({ get() {}, keys: () => [] }, () => assert.fail('reload failed'), harness.store());
		await history.reload();
		assert.equal(history.snapshot().requests, 3);
		assert.equal(history.snapshot().modelUsage[0].costMin, 12);
		assert.equal(harness.files.get('usageHistory.window.v3.1111.json'), original);
		assert.equal(JSON.parse(harness.files.get('usageHistory.total.v1.json')).total.requests, 3);
	}
});

test('one corrupt history file does not hide healthy records or delete original data', async () => {
	const data = new Map([
		['usageHistory.window.v3.1111.json', Buffer.from('{"requests":3}')],
		['usageHistory.window.v3.2222.json', Buffer.from('damaged')],
		['usageHistory.window.v3.3333.json', Buffer.from('{"modelUsage":{}}')]
	]);
	let errors = 0;
	const store = createHistoryFiles({ createDirectory: async () => {}, readDirectory: async () => [...data.keys()].map(name => [name, 1]),
		readFile: async name => data.get(name) }, '', (directory, name) => name, () => { errors++; });
	const history = createHistory({ get() {}, keys: () => [] }, () => assert.fail('whole reload must not fail'), store);
	await history.reload();
	assert.equal(history.snapshot().requests, 3);
	assert.equal(errors, 2);
	assert.equal(data.size, 3);
});

test('history base cache observes replaced legacy summaries and live legacy peer keys', async () => {
	let legacy = { requests: 10, tokensIn: 100 };
	const peers = new Map();
	const peerKey = 'usageHistory.window.v3.peer';
	const history = createHistory({ get: key => key === 'usageHistory.summary.v2' ? legacy : peers.get(key), keys: () => [...peers.keys()] },
		() => assert.fail('storage failed'), { read: async () => [['usageHistory.window.v3.file', { requests: 3, tokensIn: 30 }]], update: async () => {} });
	await history.reload();
	assert.equal(history.snapshot().requests, 13);
	legacy = { requests: 20, tokensIn: 200 };
	history.start();
	assert.equal(history.snapshot().requests, 24);
	peers.set(peerKey, { requests: 4, tokensIn: 40 });
	assert.equal(history.snapshot().requests, 28);
	peers.get(peerKey).requests = 5;
	assert.equal(history.snapshot().requests, 29);
	peers.delete(peerKey);
	assert.equal(history.snapshot().requests, 24);
	assert.equal(history.snapshot().tokensIn, 230);
	await history.flush();
});

test('history base caching preserves model-cap ordering for current-window usage', async () => {
	const records = Array.from({ length: 65 }, (_, index) => ['usageHistory.window.v3.' + index,
		{ requests: 1, modelUsage: [{ name: 'model-' + index, tokensIn: index + 1 }] }]);
	const history = createHistory({ get() {}, keys: () => [] }, () => assert.fail('reload failed'),
		{ read: async () => records, update: async () => {} });
	await history.reload();
	history.snapshot();
	history.start();
	history.finish({ model: 'model-64', hasInput: true, tokensIn: 3 });
	const snapshot = history.snapshot();
	assert.equal(snapshot.requests, 66);
	assert.equal(snapshot.modelUsage.find(row => row.name === 'model-64').tokensIn, 68);
	assert.equal(snapshot.modelUsage.find(row => row.name === '其他模型').tokensIn, 64);
	await history.flush();
});

test('file history snapshots reuse aggregation without exposing mutable cached data', async () => {
	let reads = 0;
	const row = { name: 'peer', tokensIn: 20, requests: 2 };
	const peer = { requests: 2, get modelUsage() { reads++; return [row]; } };
	const store = { read: async () => [['usageHistory.window.v3.peer', peer]], update: async () => {} };
	const storage = { get() {}, keys: () => [] };
	const history = createHistory(storage, () => assert.fail('storage failed'), store);
	await history.reload();
	const first = history.snapshot();
	assert.equal(reads, 1);
	first.requests = 500;
	first.modelUsage[0].tokensIn = 999;
	assert.equal(history.snapshot().requests, 2);
	assert.equal(history.snapshot().modelUsage[0].tokensIn, 20);
	assert.equal(reads, 1);
	history.start();
	assert.equal(history.snapshot().requests, 3);
	assert.equal(reads, 1);
	history.finish({ model: 'local', hasInput: true, tokensIn: 5 });
	assert.equal(history.snapshot().modelUsage.find(model => model.name === 'local').tokensIn, 5);
	assert.equal(reads, 1);
	row.tokensIn = 30;
	await history.reload();
	assert.equal(history.snapshot().modelUsage.find(model => model.name === 'peer').tokensIn, 30);
	assert.equal(reads, 2);
	await history.flush();
});