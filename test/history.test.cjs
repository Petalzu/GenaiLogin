const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, createHistoryFiles } = require('../stats');
const { createStats, recordRequest, applyUsage, commitRequest, createUsageParser } = require('../stats');

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
		readFile: path => fileSystem.readFile(path), writeFile: (path, bytes) => fileSystem.writeFile(path, bytes),
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
		assert.equal((await fileSystem.readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
	} finally { await fileSystem.rm(directory, { recursive: true, force: true }); }
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