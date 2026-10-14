const vscode = require('vscode');
const catalog = require('./genai-models.json');
const { readConfig, isConfigured, preset, appendModels, removableModels, removeModels } = require('./copilot-models');

async function configureModels(port) {
	try {
		const operation = await vscode.window.showQuickPick(['添加模型', '删除模型'], { title: 'GENAI Login · Copilot 模型管理' });
		if (!operation) return;
		try { await vscode.commands.executeCommand('workbench.action.openLanguageModelsJson'); } catch {}
		const active = vscode.window.activeTextEditor?.document;
		let uri = active && /\/chatLanguageModels\.json$/.test(active.uri.path) ? active.uri : undefined;
		if (!uri) {
			const fallback = await vscode.window.showWarningMessage('无法自动打开当前 Profile 的模型配置。', '手动选择文件');
			if (fallback !== '手动选择文件') return;
			const files = await vscode.window.showOpenDialog({ title: '选择当前 Profile 的 chatLanguageModels.json', canSelectMany: false, filters: { JSON: ['json'] } });
			if (!files?.length) return;
			uri = files[0];
		}
		if (!/\/chatLanguageModels\.json$/.test(uri.path)) throw new Error('请选择 chatLanguageModels.json。');
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.isDirty) throw new Error('请先保存模型配置文件，再执行增删。');
		const original = document.getText();
		const version = document.version;
		const config = readConfig(original);
		const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
		let updated, selected;
		if (operation === '添加模型') {
			const items = catalog.models.map(model => ({ label: model.name, id: model.id,
				description: isConfigured(config, model.id, endpoint) ? '已配置，将跳过' : '未配置',
				picked: isConfigured(config, model.id, endpoint) }));
			selected = await vscode.window.showQuickPick(items, { canPickMany: true, title: '选择要添加的模型（取消勾选不会删除）' });
			if (!selected?.length) return;
			selected = selected.filter(item => !isConfigured(config, item.id, endpoint));
			updated = appendModels(original, selected.map(item => preset(item.id, endpoint)), endpoint);
		} else {
			const items = removableModels(config, endpoint).map(entry => ({ ...entry, label: entry.name, description: `服务项 ${entry.providerIndex + 1}` }));
			if (!items.length) { await vscode.window.showInformationMessage('当前端口没有可删除的 GENAI 模型。'); return; }
			selected = await vscode.window.showQuickPick(items, { canPickMany: true, title: '选择要删除的 GENAI 模型' });
			if (!selected?.length) return;
			updated = removeModels(original, selected, endpoint);
		}
		if (updated === original) { await vscode.window.showInformationMessage('所选模型已配置，无需修改。'); return; }
		readConfig(updated);
		const confirm = await vscode.window.showWarningMessage(`${operation}：${selected.map(item => item.label).join('、')}`, {
			modal: true, detail: `文件：${uri.toString()}\n反代：${endpoint}\n将备份原文件；仅删除选中项，未选模型的原文和参数保持不变。`
		}, '确认保存');
		if (confirm !== '确认保存') return;
		const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		if (document.version !== version || document.isDirty || disk !== original) throw new Error('文件已发生变化，请重新执行，避免覆盖其他编辑。');
		const backup = uri.with({ path: `${uri.path}.genai-${Date.now()}.bak` });
		await vscode.workspace.fs.copy(uri, backup, { overwrite: false });
		const latestDisk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		if (document.version !== version || document.isDirty || latestDisk !== original) throw new Error('文件在备份期间发生变化，请重新执行，避免覆盖其他编辑。');
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), updated);
		if (!await vscode.workspace.applyEdit(edit)) throw new Error('无法应用配置编辑。');
		if (!await document.save()) throw new Error('配置尚未保存，请检查已打开的文件。');
		await vscode.window.showInformationMessage(`已${operation} ${selected.length} 个。备份：${backup.path}。若 Copilot 未刷新，请重新加载窗口。`);
	} catch (error) {
		await vscode.window.showErrorMessage(`GENAI 模型配置失败：${error.message}`);
	}
}

module.exports = { configureModels };