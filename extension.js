const vscode = require('vscode');
const http = require('node:http');
const { createRequestLifetime, forwardBody, transportCode } = require('./bridge-stream');
const { dashboardHtml } = require('./dashboard');
const { createStats, createHistory, recordRequest, commitRequest, createUsageParser, modelUsageRows, DEEPSEEK_PRICING } = require('./stats');

let stopActive;

class DashboardProvider {
	constructor(getState, actions, onError, onVisibility = () => {}, trace = () => {}) {
		this.trace = trace;
		this.onVisibility = onVisibility;
		this.getState = getState;
		this.actions = actions;
		this.onError = onError;
		this.view = undefined;
		this.messageSubscription = undefined;
		this.disposeSubscription = undefined;
	}

	resolveWebviewView(view) {
		const startedAt = Date.now();
		this.dispose();
		this.view = view;
		view.webview.options = { enableScripts: true };
		this.messageSubscription = view.webview.onDidReceiveMessage(message => {
			if (message?.command === 'ready') {
				this.trace(`Dashboard script ready: elapsedMs=${Date.now() - startedAt}`);
				this.refresh();
				return;
			}
			if (message?.command === 'painted') {
				this.trace(`Dashboard frame ready: elapsedMs=${Date.now() - startedAt}`);
				return;
			}
			if (message?.command === 'refresh') {
				this.refresh();
				return;
			}
			const action = this.actions[message?.command];
			if (action) Promise.resolve(action()).catch(this.onError);
		});
		view.webview.html = dashboardHtml(this.getState());
		this.trace(`Dashboard HTML assigned: elapsedMs=${Date.now() - startedAt}`);
		this.visibilitySubscription = view.onDidChangeVisibility(() => {
			if (view.visible) this.refresh();
			this.onVisibility(view.visible);
		});
		this.disposeSubscription = view.onDidDispose(() => this.dispose());
		this.onVisibility(view.visible);
	}

	refresh() {
		this.view?.webview.postMessage({ type: 'state', data: this.getState() });
	}

	dispose() {
		this.onVisibility(false);
		this.visibilitySubscription?.dispose();
		this.messageSubscription?.dispose();
		this.disposeSubscription?.dispose();
		this.view = undefined;
	}
}

function activate(context) {
	const output = vscode.window.createOutputChannel('GENAI Login');
	context.subscriptions.push(output);
	const trace = message => output.appendLine(`${new Date().toISOString()} ${message}`);
	const history = createHistory(context.globalState, () => trace('History persistence failed; totals may not survive reload.'));
	let server, active, authentication, keepaliveTimer, keepaliveOwner;
	let state = 'Disconnected';
	let dashboard;
	let sharedState, syncInFlight, syncDisposed = false;
	let syncController = new AbortController();
	let syncTimer;
	let keepaliveInfo = { state: 'idle', lastCheckAt: null };
	const configuredPort = vscode.workspace.getConfiguration('genai-login').get('port', 58379);
	const stats = createStats(Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535 ? configuredPort : 58379);
	let dispatcher;
	context.subscriptions.push({ dispose: () => { void dispatcher?.destroy().catch(() => {}); } });
	const status = value => { state = value; dashboard?.refresh(); };
	const localSnapshot = () => ({
		status: state,
		history: history.snapshot(),
		port: stats.port,
		connectedAt: stats.connectedAt,
		requests: stats.requests,
		tokensIn: stats.tokensIn,
		tokensOut: stats.tokensOut,
		usageReports: stats.usageReports,
		usageMissing: stats.usageMissing,
		inputUsageReports: stats.inputUsageReports,
		outputUsageReports: stats.outputUsageReports,
		modelUsage: modelUsageRows(stats.modelUsage),
		pricing: DEEPSEEK_PRICING,
		models: [...stats.models].map(([name, requests]) => ({ name, requests })).concat(stats.otherModels ? [{ name: '其他模型', requests: stats.otherModels }] : []),
		keepalive: { ...keepaliveInfo }
	});
	const stateSnapshot = () => !active && sharedState ? { ...sharedState, status: `${sharedState.status} (shared window)` } : localSnapshot();
	const syncSharedState = () => {
		if (syncDisposed || active) return Promise.resolve();
		if (syncInFlight) return syncInFlight;
		const currentController = syncController;
		syncInFlight = (async () => {
			let next;
			try {
				const response = await fetch(`http://127.0.0.1:${stats.port}/internal/status`, {
					headers: { Authorization: 'Bearer local-browser-session' },
					redirect: 'error',
					signal: AbortSignal.any([currentController.signal, AbortSignal.timeout(1500)])
				});
				if (!response.ok) { await response.body?.cancel(); return; }
				const payload = await response.json();
				if (payload.service === 'genai-login' && payload.version === 1 &&
					payload.state?.port === stats.port && typeof payload.state.status === 'string' &&
					Array.isArray(payload.state.models) && payload.state.keepalive) next = payload.state;
			} catch {}
			finally {
				if (!syncDisposed && !active && !currentController.signal.aborted) { sharedState = next; dashboard?.refresh(); }
			}
		})().finally(() => { if (currentController === syncController) syncInFlight = undefined; });
		return syncInFlight;
	};
	const setSyncVisible = visible => {
		clearInterval(syncTimer);
		syncTimer = undefined;
		if (!visible || syncDisposed) {
			syncController.abort();
			syncController = new AbortController();
			syncInFlight = undefined;
			return;
		}
		void syncSharedState();
		syncTimer = setInterval(() => { void syncSharedState(); }, 2000);
		syncTimer.unref?.();
	};
	const requireOwner = async () => {
		if (!active) await syncSharedState();
		if (!active && sharedState) {
			await vscode.window.showInformationMessage('GENAI is connected in another VS Code window. Manage the connection in that window.');
			return false;
		}
		return true;
	};
	const stop = () => {
		active?.abort(); active = undefined; authentication = undefined;
		clearTimeout(keepaliveTimer); keepaliveTimer = undefined; keepaliveOwner = undefined;
		keepaliveInfo = { state: 'idle', lastCheckAt: null };
		server?.closeAllConnections(); server?.close(); server = undefined;
		stats.connectedAt = null; stats.requests = 0; stats.tokensIn = 0; stats.tokensOut = 0; stats.usageReports = 0; stats.usageMissing = 0; stats.models.clear(); stats.otherModels = 0;
		stats.inputUsageReports = 0; stats.outputUsageReports = 0;
		stats.modelUsage.clear();
		status('Disconnected');
	};
	stopActive = stop;
	const credentials = async () => {
		if (!await requireOwner()) return false;
		if (active) throw new Error('Disconnect before changing credentials.');
		const username = await vscode.window.showInputBox({ title: 'UMPASS account', prompt: 'Full UMPASS login name', ignoreFocusOut: true });
		if (!username) return false;
		const password = await vscode.window.showInputBox({ title: 'UMPASS password', password: true, ignoreFocusOut: true });
		if (!password) return false;
		if (!await requireOwner()) return false;
		if (active) throw new Error('Disconnect before changing credentials.');
		await context.secrets.store('credentials', JSON.stringify({ username, password }));
		await context.secrets.delete('session');
		return true;
	};
	const connect = async (diagnostic = false) => {
		if (active) return;
		await syncSharedState();
		if (active || sharedState) return;
		output.show(true);
		trace(diagnostic ? 'Visible diagnostic connection requested' : 'Manual connection requested');
		let stored = await context.secrets.get('credentials');
		if (!stored) { if (!await credentials()) return; stored = await context.secrets.get('credentials'); }
		if (active) return;
		const controller = new AbortController(); active = controller;
		try {
		const { Agent, fetch: upstreamFetch } = require('undici');
		const { Session, ORIGIN } = require('./auth');
		const { browserLogin: login } = require('./browser-auth');
		dispatcher ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
		keepaliveOwner = controller;
		let keepaliveInFlight = false;
		const account = JSON.parse(stored);
		let session;
		try { session = new Session(await context.secrets.get('session'), trace); } catch { trace('Saved cookie jar unavailable; starting fresh'); session = new Session(undefined, trace); }
		if (controller.signal.aborted) return;
		const persist = async () => { controller.signal.throwIfAborted(); await context.secrets.store('session', JSON.stringify(session.jar.toJSON())); };
		const authenticate = () => {
			if (!authentication) {
				status('Authenticating');
				authentication = login(session, account, controller.signal, trace, undefined, true, !diagnostic).then(async () => { await persist(); stats.connectedAt ??= Date.now(); trace('Authenticated; session saved'); status(`Connected :${stats.port}`); }).finally(() => { if (active === controller) authentication = undefined; });
			}
			return authentication;
		};
		const scheduleKeepalive = () => {
			if (keepaliveOwner !== controller || active !== controller || controller.signal.aborted) return;
			clearTimeout(keepaliveTimer);
			keepaliveTimer = setTimeout(runKeepalive, 60000);
		};
		const isCurrentConnection = () => keepaliveOwner === controller && active === controller && !controller.signal.aborted;
		const runKeepalive = async () => {
			if (!isCurrentConnection() || keepaliveInFlight) return;
			keepaliveInFlight = true;
			keepaliveInfo = { state: 'checking', lastCheckAt: Date.now() };
			dashboard?.refresh();
			try {
				const valid = await session.valid(AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
				if (!isCurrentConnection()) return;
				if (valid) {
					await persist();
					if (!isCurrentConnection()) return;
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					trace('Keepalive: session valid');
				} else {
					keepaliveInfo = { state: 'reauthenticating', lastCheckAt: Date.now() };
					dashboard?.refresh();
					trace('Keepalive: session expired; reauthenticating');
					await authenticate();
					if (!isCurrentConnection()) return;
					await persist();
					if (!isCurrentConnection()) return;
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					trace('Keepalive: reauthenticated');
				}
			} catch { if (isCurrentConnection()) { keepaliveInfo = { state: 'error', lastCheckAt: Date.now() }; trace('Keepalive: check failed; will retry'); } }
			finally {
				keepaliveInFlight = false;
				if (isCurrentConnection()) { scheduleKeepalive(); dashboard?.refresh(); }
			}
		};
		const startKeepalive = () => { clearTimeout(keepaliveTimer); scheduleKeepalive(); };
		const sendError = (response, code, message) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message } })); };
		const settleRequest = requestStats => {
			history.finish(requestStats);
			if (active !== controller || controller.signal.aborted) return;
			if (commitRequest(stats, requestStats)) dashboard?.refresh();
		};
		const handle = async (request, response) => {
			const fetchSite = request.headers['sec-fetch-site'];
			const rejected = request.headers.host !== `127.0.0.1:${stats.port}` ? 'host mismatch' : request.headers.origin ? 'Origin present' : fetchSite !== undefined && fetchSite !== 'none' ? `Fetch Metadata rejected (${['same-origin', 'same-site', 'cross-site'].includes(fetchSite) ? fetchSite : 'unrecognized'})` : request.headers.authorization !== 'Bearer local-browser-session' ? (request.headers.authorization ? 'Authorization mismatch' : 'Authorization missing') : '';
			if (rejected) { trace(`Local request rejected: ${rejected}`); return sendError(response, 403, `Local authenticated clients only: ${rejected}`); }
			if (request.method === 'GET' && request.url === '/internal/status') {
				response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
				return response.end(JSON.stringify({ service: 'genai-login', version: 1, state: localSnapshot() }));
			}
			const route = request.method === 'POST' && request.url === '/v1/chat/completions' ? '/api/v1/chat/completions' : request.method === 'GET' && request.url === '/v1/models' ? '/api/v1/models' : null;
			if (!route) return sendError(response, 404, 'Not found');
			if (authentication) await authentication;
			const chunks = []; let size = 0;
			for await (const chunk of request) { size += chunk.length; if (size > 20 * 1024 * 1024) return sendError(response, 413, 'Request too large'); chunks.push(chunk); }
			if (response.destroyed) return;
			const idleSeconds = vscode.workspace.getConfiguration('genai-login').get('idleTimeoutSeconds', 0);
			const lifetime = createRequestLifetime(response, controller.signal, Number.isInteger(idleSeconds) && idleSeconds >= 0 && idleSeconds <= 86400 ? idleSeconds * 1000 : 0);
			const startedAt = Date.now();
			let bytes = 0;
			let requestStats, usageParser;
			try {
			const options = { method: request.method, body: request.method === 'POST' ? Buffer.concat(chunks) : undefined, headers: { 'content-type': 'application/json', Accept: 'application/json' }, signal: lifetime.signal, fetch: upstreamFetch, dispatcher };
			if (request.method === 'POST') {
				requestStats = recordRequest(stats, options.body);
				history.start();
				dashboard?.refresh();
			}
			let result = await session.request(ORIGIN + route, options);
			if (result.status === 401) {
				await result.body?.cancel();
				try { await authenticate(); } catch { sendError(response, 401, 'Automatic login failed; reconnect after checking credentials or verification.'); if (active === controller) stop(); return; }
				lifetime.signal.throwIfAborted();
				lifetime.touch();
				result = await session.request(ORIGIN + route, options);
			}
			lifetime.touch();
			await persist(); status(`Connected :${stats.port}`);
			const contentType = result.headers.get('content-type') || 'application/json';
			response.writeHead(result.status, { 'content-type': contentType });
			if (!result.body) { settleRequest(requestStats); return response.end(); }
			usageParser = createUsageParser(contentType, requestStats);
			await forwardBody(result.body, response, lifetime, chunk => {
				bytes += chunk.length;
				usageParser.consume(chunk);
			}, result.status === 200 && contentType.toLowerCase().includes('text/event-stream'));
			trace(`Proxy completed: status=${result.status} elapsedMs=${Date.now() - startedAt} bytes=${bytes}`);
			} catch (error) {
				const reason = lifetime.signal.reason?.name === 'TimeoutError' ? lifetime.signal.reason : error;
				trace(`Proxy failed: code=${transportCode(reason)} elapsedMs=${Date.now() - startedAt} bytes=${bytes} cancelled=${lifetime.signal.aborted}`);
				throw error;
			} finally {
				lifetime.dispose();
				usageParser?.finish();
				if (usageParser) trace(`Proxy formatting: ${JSON.stringify(usageParser.formatting)}`);
				settleRequest(requestStats);
			}
		};
		server = http.createServer((request, response) => { handle(request, response).catch(() => {
			if (response.destroyed) return;
			if (!controller.signal.aborted) status('Network error; retry request');
			if (!response.headersSent) sendError(response, 502, 'Upstream request failed. Retry when network is available.'); else response.destroy();
		}); });
			status('Connecting');
			await new Promise((resolve, reject) => { server.once('error', reject); server.listen(stats.port, '127.0.0.1', resolve); });
			await authenticate();
			startKeepalive();
		} catch (error) {
			trace('Connection failed; inspect preceding stage (no credentials logged)'); output.show(true);
			if (active === controller) stop();
			if (error.code === 'EADDRINUSE') { await syncSharedState(); if (sharedState) return; }
			throw error;
		}
	};
	let configuringModels = false;
	const models = async () => {
		if (configuringModels) return;
		configuringModels = true;
		try { await require('./copilot-config').configureModels(stats.port); }
		finally { configuringModels = false; }
	};
	const port = async () => {
		try {
			const configuration = vscode.workspace.getConfiguration('genai-login');
			const value = await vscode.window.showInputBox({
				title: '设置 GENAI 端口',
				value: String(configuration.get('port', 58379)),
				prompt: `当前窗口使用 ${stats.port}；输入 1024–65535，留空恢复默认 58379。重载后生效。`,
				ignoreFocusOut: true,
				validateInput: input => !input.trim() || (/^\d+$/.test(input.trim()) && Number(input) >= 1024 && Number(input) <= 65535) ? undefined : '请输入 1024–65535 的整数端口。'
			});
			if (value === undefined) return;
			const next = value.trim() ? Number(value) : 58379;
			if (!Number.isInteger(next) || next < 1024 || next > 65535) return;
			await configuration.update('port', value.trim() ? next : undefined, vscode.ConfigurationTarget.Global);
			await vscode.window.showInformationMessage(`端口已设为 ${next}。当前连接不变；请在任务结束后重载相关窗口，并将 Copilot 模型 URL 更新为 http://127.0.0.1:${next}/v1/chat/completions。`);
		} catch (error) { await vscode.window.showErrorMessage(`端口设置失败：${error.message}`); }
	};
	const diagnose = async () => {
		if (!await requireOwner()) return;
		if (active) { await vscode.window.showInformationMessage('Disconnect GENAI before starting a visible diagnostic login.'); return; }
		await connect(true);
	};
	const actions = { connect, diagnose, credentials, models, port, disconnect: async () => { if (await requireOwner()) stop(); }, clear: async () => { if (!await requireOwner()) return; stop(); await context.secrets.delete('credentials'); await context.secrets.delete('session'); } };
	const reportError = error => vscode.window.showErrorMessage(error?.code === 'EADDRINUSE' ? `Port ${stats.port} is occupied. Stop the old bridge or configure another port and reload.` : 'GENAI login failed or timed out. Check GENAI Login output, installed Edge, credentials and MFA.');
	for (const [name, action] of Object.entries(actions)) context.subscriptions.push(vscode.commands.registerCommand(`genai-login.${name}`, async () => {
		try { await action(); } catch (error) { reportError(error); }
	}));
	dashboard = new DashboardProvider(stateSnapshot, actions, reportError, setSyncVisible, trace);
	context.subscriptions.push({ dispose: () => { syncDisposed = true; clearInterval(syncTimer); syncController.abort(); } });
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('genai-login.session', dashboard, { webviewOptions: { retainContextWhenHidden: true } }), { dispose: () => dashboard.dispose() }, { dispose: stop });
}
function deactivate() { stopActive?.(); }
module.exports = { activate, deactivate };
