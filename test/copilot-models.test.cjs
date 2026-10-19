const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig, isConfigured, preset, appendModels } = require('../copilot-models');
const endpoint = 'http://127.0.0.1:58379/v1/chat/completions';
test('external change during backup refuses edit even with unchanged editor version', async () => {
	const fs = require('node:fs');
	const vm = require('node:vm');
	let reads = 0, backups = 0, step = 0;
	const errors = [];
	const uri = { path: '/User/chatLanguageModels.json', toString: () => 'file:///User/chatLanguageModels.json', with: value => value };
	const api = {
		commands: { executeCommand: async () => {} },
		window: {
			activeTextEditor: { document: { uri } },
			showQuickPick: async items => ++step === 1 ? '添加模型' : [items[0]],
			showWarningMessage: async () => '确认保存',
			showErrorMessage: async message => errors.push(message)
		},
		workspace: {
			openTextDocument: async () => ({ isDirty: false, version: 1, getText: () => '[]' }),
			fs: {
				readFile: async () => Buffer.from(++reads === 1 ? '[]' : '[{"name":"external-change"}]'),
				copy: async () => { backups++; }
			},
			applyEdit: () => assert.fail('must not overwrite concurrent changes')
		},
		WorkspaceEdit: function () { assert.fail('must reject before constructing an edit'); }
	};
	const sandbox = { Buffer, module: { exports: {} }, require: name => name === 'vscode' ? api : require('../' + name.slice(2)) };
	vm.runInNewContext(fs.readFileSync(require.resolve('../copilot-config'), 'utf8'), sandbox);
	await sandbox.module.exports.configureModels(58379);
	assert.equal(reads, 2);
	assert.equal(backups, 1);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /备份期间发生变化/);
});
test('deleting the only model and setting supports JSONC trailing commas', () => {
	const { removableModels, removeModels } = require('../copilot-models');
	const text = '[{"models":[' + JSON.stringify(preset('DeepSeek-V4.1-Flash', endpoint)) + ',],"settings":{"DeepSeek-V4.1-Flash":{"reasoningEffort":"max"},},"untouched":42},]';
	const result = removeModels(text, removableModels(readConfig(text), endpoint), endpoint);
	assert.deepEqual(readConfig(result), [{ models: [], settings: {}, untouched: 42 }]);
});
test('single deletion preserves untouched model text, custom parameters and comments', () => {
	const { removableModels, removeModels } = require('../copilot-models');
	const catalog = require('../genai-models.json');
	for (const spacing of [undefined, 2, '\t']) {
		const provider = structuredClone(catalog);
		provider.models.forEach(model => { model.custom = { temperature: 0.72, nested: ['keep', 123] }; });
		const text = JSON.stringify([provider], null, spacing).replace('"models":', '/* preserve provider comment */ "models":');
		for (const entry of removableModels(readConfig(text), endpoint)) {
			const result = removeModels(text, [entry], endpoint);
			const expected = structuredClone(provider);
			expected.models.splice(entry.modelIndex, 1);
			delete expected.settings[entry.id];
			assert.deepEqual(readConfig(result), [expected]);
			assert.ok(result.includes('/* preserve provider comment */'));
			const { parseTree, findNodeAtLocation } = require('jsonc-parser');
			provider.models.forEach((model, index) => {
				if (index === entry.modelIndex) return;
				const node = findNodeAtLocation(parseTree(text), [0, 'models', index]);
				assert.ok(result.includes(text.slice(node.offset, node.offset + node.length)));
			});
		}
	}
});
test('configuration cancelled at confirmation never writes or backs up files', async () => {
	const fs = require('node:fs');
	const vm = require('node:vm');
	const uri = { path: '/User/chatLanguageModels.json', toString: () => 'file:///User/chatLanguageModels.json' };
	let step = 0;
	const api = {
		commands: { executeCommand: async command => assert.equal(command, 'workbench.action.openLanguageModelsJson') },
		window: {
			activeTextEditor: { document: { uri } },
			showQuickPick: async items => ++step === 1 ? '添加模型' : [items[0]],
			showWarningMessage: async () => undefined,
			showErrorMessage: message => assert.fail(message)
		},
		workspace: {
			openTextDocument: async () => ({ isDirty: false, version: 1, getText: () => '[]' }),
			fs: { readFile: () => assert.fail('unexpected read'), copy: () => assert.fail('unexpected backup') },
			applyEdit: () => assert.fail('unexpected write')
		}
	};
	const sandbox = { module: { exports: {} }, require: name => name === 'vscode' ? api : require('../' + name.slice(2)) };
	vm.runInNewContext(fs.readFileSync(require.resolve('../copilot-config'), 'utf8'), sandbox);
	await sandbox.module.exports.configureModels(58379);
	assert.equal(step, 2);
});
test('removal preserves other endpoints, shared settings and unrelated providers', () => {
	const { removableModels, removeModels } = require('../copilot-models');
	const id = 'DeepSeek-V4.1-Flash';
	const text = JSON.stringify([{ models: [preset(id, endpoint), preset(id, 'https://example.com/v1/chat/completions'), preset('GLM-5.3-Flash', endpoint)], settings: { [id]: { reasoningEffort: 'low' }, 'GLM-5.3-Flash': { reasoningEffort: 'max' }, other: {} } }, { name: 'unrelated' }]);
	const entries = removableModels(readConfig(text), endpoint);
	assert.equal(entries.length, 2);
	const result = readConfig(removeModels(text, entries, endpoint));
	assert.equal(result[0].models.length, 1);
	assert.equal(result[0].settings[id].reasoningEffort, 'low');
	assert.equal(result[0].settings['GLM-5.3-Flash'], undefined);
	assert.deepEqual(result[1], { name: 'unrelated' });
	assert.equal(removeModels(text, [], endpoint), text);
});

test('append preserves comments, other providers and settings and is idempotent', () => {
	const original = '[\n// Keep this comment\n{"name":"Other","models":[],"apiKey":"untouched"}\n]';
	const models = [preset('DeepSeek-V4.1-Flash', endpoint), preset('GLM-5.3-Flash', endpoint)];
	const updated = appendModels(original, models, endpoint);
	assert.ok(updated.includes('// Keep this comment'));
	assert.deepEqual(readConfig(updated)[0], readConfig(original)[0]);
	assert.equal(readConfig(updated)[1].settings['GLM-5.3-Flash'].reasoningEffort, 'max');
	assert.equal(appendModels(updated, models, endpoint), updated);
	const firstOnly = appendModels(original, [models[0]], endpoint);
	const expanded = appendModels(firstOnly, [models[1]], endpoint);
	assert.equal(readConfig(expanded).length, 2);
	assert.equal(readConfig(expanded)[1].models.length, 2);
	assert.equal(readConfig(expanded)[1].settings['GLM-5.3-Flash'].reasoningEffort, 'max');
});

test('deduplication requires both local endpoint and model identity', () => {
	const config = [{ models: [{ name: 'GENAI / sample', url: endpoint.replace('127.0.0.1', 'localhost') + '/' }] }];
	assert.ok(isConfigured(config, 'sample', endpoint));
	assert.equal(isConfigured(config, 'other', endpoint), false);
	assert.equal(isConfigured(config, 'sample', endpoint.replace('58379', '58480')), false);
	assert.throws(() => readConfig('{broken'));
	assert.throws(() => preset('unknown', endpoint), /catalog/);
});

test('presets preserve reviewed parameters and isolate port overrides', () => {
	const catalog = require('../genai-models.json');
	for (const model of catalog.models) {
		const configured = preset(model.id, endpoint.replace('58379', '58480'));
		assert.deepEqual(configured, { ...model, url: endpoint.replace('58379', '58480') });
		configured.requestHeaders.Authorization = 'changed';
		assert.equal(model.requestHeaders.Authorization, 'Bearer local-browser-session');
		if (model.thinking) assert.ok(model.supportsReasoningEffort.includes(catalog.settings[model.id].reasoningEffort));
		else assert.equal(catalog.settings[model.id], undefined);
	}
});

test('all seven chat models append once with valid context budgets', () => {
	const catalog = require('../genai-models.json');
	const limits = { 'gemma-4-31B-it': 180000, 'gpt-oss-120b': 131072, 'GLM-OCR': 131072,
		'Qwen3.8-27B': 262144, 'Qwen3.5-397B-A17B': 262144, 'DeepSeek-V4.1-Flash': 1048576, 'GLM-5.3-Flash': 1048576 };
	assert.deepEqual(catalog.models.map(model => model.id).sort(), Object.keys(limits).sort());
	for (const model of catalog.models) assert.ok(model.maxInputTokens + model.maxOutputTokens <= limits[model.id]);
	const models = catalog.models.map(model => preset(model.id, endpoint));
	const result = appendModels('[]', models, endpoint);
	assert.equal(readConfig(result)[0].models.length, 7);
	assert.equal(appendModels(result, models, endpoint), result);
});

test('image models are not available as Copilot presets', () => {
	assert.throws(() => preset('qwen-image-2.1', endpoint), /not in the reviewed catalog/);
});

test('configure command offers chat models only, backs up additions and skips duplicates', async () => {
	const fs = require('node:fs');
	const vm = require('node:vm');
	for (const port of [58379, 58480]) {
		const localEndpoint = endpoint.replace('58379', String(port));
		const existing = [
			{ name: 'Other', vendor: 'customendpoint', apiKey: '${input:unchanged}', apiType: 'messages', models: [{ id: 'other', url: 'https://example.com/v1/messages' }], settings: { other: { reasoningEffort: 'high' } } },
			{ name: 'GENAI Chat', vendor: 'customendpoint', apiKey: 'local-browser-session', apiType: 'chat-completions',
				models: [preset('DeepSeek-V4.1-Flash', localEndpoint), preset('GLM-5.3-Flash', localEndpoint)],
				settings: { 'DeepSeek-V4.1-Flash': { reasoningEffort: 'low' }, 'GLM-5.3-Flash': { reasoningEffort: 'max' } } }
		];
		const original = JSON.stringify(existing, null, '\t').replace('[', '[\n// keep profile comment');
		let text = original, disk = original, staged, backups = 0, writes = 0, saves = 0, picks = 0;
		const uri = { path: '/User/chatLanguageModels.json', toString: () => 'vscode-userdata:/User/chatLanguageModels.json', with: value => value };
		const document = { uri, isDirty: false, version: 1, getText: () => text, positionAt: offset => offset,
			save: async () => { saves++; disk = text; document.isDirty = false; return true; } };
		const api = {
			commands: { executeCommand: async command => assert.equal(command, 'workbench.action.openLanguageModelsJson') },
			window: {
				activeTextEditor: { document },
				showQuickPick: async items => {
					if (++picks % 2 === 1) return '添加模型';
					assert.equal(items.length, 7);
					assert.ok(items.every(item => !item.id.startsWith('qwen-image')));
					const chatModel = items.find(item => item.id === 'Qwen3.8-27B');
					assert.ok(chatModel);
					assert.equal(chatModel.picked, writes > 0);
					return [chatModel];
				},
				showWarningMessage: async () => '确认保存', showInformationMessage: async () => {},
				showErrorMessage: message => assert.fail(message)
			},
			workspace: {
				openTextDocument: async () => document,
				fs: { readFile: async () => Buffer.from(disk), copy: async (source, backup, options) => {
					assert.equal(source, uri);
					assert.match(backup.path, /chatLanguageModels\.json\.genai-\d+\.bak$/);
					assert.equal(options.overwrite, false);
					assert.equal(disk, original);
					backups++;
				} },
				applyEdit: async () => { writes++; text = staged; document.version++; document.isDirty = true; return true; }
			},
			WorkspaceEdit: function () { this.replace = (target, range, value) => { assert.equal(target, uri); staged = value; }; },
			Range: function () {}
		};
		const sandbox = { Buffer, module: { exports: {} }, require: name => name === 'vscode' ? api : require('../' + name.slice(2)) };
		vm.runInNewContext(fs.readFileSync(require.resolve('../copilot-config'), 'utf8'), sandbox);
		await sandbox.module.exports.configureModels(port);
		const configured = readConfig(disk);
		assert.ok(disk.includes('// keep profile comment'));
		assert.deepEqual(configured[0], existing[0]);
		assert.deepEqual(configured[1], { ...existing[1], models: [...existing[1].models, preset('Qwen3.8-27B', localEndpoint)],
			settings: { ...existing[1].settings, 'Qwen3.8-27B': { reasoningEffort: 'xhigh' } } });
		await sandbox.module.exports.configureModels(port);
		assert.equal(readConfig(disk)[1].models.length, 3);
		assert.equal(backups, 1);
		assert.equal(writes, 1);
		assert.equal(saves, 1);
	}
});