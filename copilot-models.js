const { parse, modify, applyEdits, parseTree, findNodeAtLocation, createScanner, SyntaxKind } = require('jsonc-parser');

const catalog = require('./genai-models.json');

function readConfig(text) {
	const errors = [];
	const config = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !Array.isArray(config)) throw new Error('Model configuration must be a valid JSON/JSONC array.');
	return config;
}

function sameEndpoint(value, endpoint) {
	try {
		const address = new URL(value);
		const expected = new URL(endpoint);
		return address.protocol === expected.protocol && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) && address.port === expected.port && address.pathname.replace(/\/$/, '') === expected.pathname;
	} catch { return false; }
}

function isConfigured(config, id, endpoint) {
	return config.some(provider => Array.isArray(provider?.models) && provider.models.some(model => model && sameEndpoint(model.url, endpoint) &&
		(model.id === id || model.name === id || model.name === `GENAI / ${id}`)));
}

function preset(id, endpoint) {
	const model = catalog.models.find(item => item.id === id);
	if (!model) throw new Error(`Model is not in the reviewed catalog: ${id}`);
	return { ...structuredClone(model), url: endpoint };
}

function appendModels(text, models, endpoint) {
	const config = readConfig(text);
	const added = [];
	for (const model of models) {
		if (!isConfigured(config, model.id, endpoint) && !added.some(existing => existing.id === model.id)) added.push(model);
	}
	if (!added.length) return text;
	const settings = {};
	for (const model of added) {
		if (catalog.settings[model.id]) settings[model.id] = structuredClone(catalog.settings[model.id]);
	}
	const provider = { ...structuredClone(catalog), models: added, settings };
	const index = config.findIndex(item => item?.name === 'GENAI Chat' && item.vendor === 'customendpoint' && item.apiType === 'chat-completions' && Array.isArray(item.models));
	const options = { formattingOptions: { insertSpaces: false, tabSize: 4, eol: text.includes('\r\n') ? '\r\n' : '\n' } };
	if (index < 0) return applyEdits(text, modify(text, [config.length], provider, options));
	let result = text;
	for (const [offset, model] of added.entries()) result = applyEdits(result, modify(result, [index, 'models', config[index].models.length + offset], model, options));
	for (const [id, setting] of Object.entries(settings)) {
		if (config[index].settings?.[id] === undefined) result = applyEdits(result, modify(result, [index, 'settings', id], setting, options));
	}
	return result;
}

function removableModels(config, endpoint) {
	const entries = [];
	config.forEach((provider, providerIndex) => {
		if (!Array.isArray(provider?.models)) return;
		provider.models.forEach((model, modelIndex) => {
			if (model && sameEndpoint(model.url, endpoint) && (catalog.models.some(known => known.id === model.id || known.name === model.name || known.id === model.name) ||
				model.id === 'DeepSeek-V4.1-Flash' || ['DeepSeek-V4.1-Flash', 'GENAI / DeepSeek-V4.1-Flash'].includes(model.name))) {
				entries.push({ providerIndex, modelIndex, id: model.id, name: model.name || model.id });
			}
		});
	});
	return entries;
}

function removeNode(text, path) {
	let node = findNodeAtLocation(parseTree(text), path);
	if (!node) return text;
	if (node.parent.type === 'property') node = node.parent;
	const siblings = node.parent.children;
	const index = siblings.indexOf(node);
	let start = node.offset;
	let end = start + node.length;
	const scanner = createScanner(text, true);
	if (index < siblings.length - 1) {
		scanner.setPosition(end);
		if (scanner.scan() !== SyntaxKind.CommaToken) throw new Error('Cannot safely locate model separator.');
		end = scanner.getTokenOffset() + scanner.getTokenLength();
	} else if (index > 0) {
		const previous = siblings[index - 1];
		scanner.setPosition(previous.offset + previous.length);
		if (scanner.scan() !== SyntaxKind.CommaToken) throw new Error('Cannot safely locate model separator.');
		start = scanner.getTokenOffset();
	} else {
		scanner.setPosition(end);
		if (scanner.scan() === SyntaxKind.CommaToken) end = scanner.getTokenOffset() + scanner.getTokenLength();
	}
	return applyEdits(text, [{ offset: start, length: end - start, content: '' }]);
}

function removeModels(text, selected, endpoint) {
	const config = readConfig(text);
	const allowed = removableModels(config, endpoint);
	const entries = allowed.filter(entry => selected.some(item => item.providerIndex === entry.providerIndex && item.modelIndex === entry.modelIndex));
	entries.sort((left, right) => right.providerIndex - left.providerIndex || right.modelIndex - left.modelIndex);
	let result = text;
	const expected = structuredClone(config);
	for (const entry of entries) {
		expected[entry.providerIndex].models.splice(entry.modelIndex, 1);
		result = removeNode(result, [entry.providerIndex, 'models', entry.modelIndex]);
		const remaining = readConfig(result)[entry.providerIndex];
		if (entry.id && !remaining.models.some(model => model?.id === entry.id) && remaining.settings?.[entry.id] !== undefined) {
			result = removeNode(result, [entry.providerIndex, 'settings', entry.id]);
			delete expected[entry.providerIndex].settings[entry.id];
		}
	}
	if (!require('node:util').isDeepStrictEqual(readConfig(result), expected)) throw new Error('Deletion changed unrelated parameters; refusing to save.');
	return result;
}

module.exports = { readConfig, isConfigured, preset, appendModels, removableModels, removeModels };