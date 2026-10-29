const vscode = require('vscode');
const http = require('node:http');
const { createRequestLifetime, waitForSignal, forwardBody, createBridgeAdmission, proxyResponseHeaders, transportCode } = require('./bridge-stream');
const { MAX_JSON_REQUEST_BODY, createStats, createHistory, createHistoryFiles, parseRequestBody, recordRequest, commitRequest, createUsageParser, modelUsageRows, DEEPSEEK_PRICING } = require('./stats');

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
		view.webview.html = require('./dashboard').dashboardHtml(this.getState());
		this.trace(`Dashboard HTML assigned: elapsedMs=${Date.now() - startedAt}`);
		this.visibilitySubscription = view.onDidChangeVisibility(() => {
			if (view.visible) this.refresh();
			this.onVisibility(view.visible);
		});
		this.disposeSubscription = view.onDidDispose(() => this.dispose());
		this.onVisibility(view.visible);
	}

	refresh() {
		if (this.view?.visible) this.view.webview.postMessage({ type: 'state', data: this.getState() });
	}

	dispose() {
		this.onVisibility(false);
		this.visibilitySubscription?.dispose();
		this.messageSubscription?.dispose();
		this.disposeSubscription?.dispose();
		this.view = undefined;
	}
}

// The platform answers image generation with its internal file descriptors
// ([{ id, url, name, content_type }]); OpenAI Images clients expect the decoded
// bytes inline, so the proxy downloads each platform file and re-wraps it as
// data[].b64_json.
async function convertImageResponse(payload, downloadImage) {
	const entries = Array.isArray(payload) ? payload : [];
	if (entries.length > 6) throw new Error('Too many generated images');
	const data = [];
	let remaining = 20 * 1024 * 1024;
	for (const entry of entries) {
		if (!entry || typeof entry.url !== 'string' || !entry.url.trim()) throw new Error('Invalid image file reference');
		const bytes = await downloadImage(entry.url, remaining);
		if (!detectImageMimeType(bytes)) throw new Error('Unsupported image file format');
		remaining -= bytes.length;
		data.push({ b64_json: bytes.toString('base64') });
	}
	return data;
}

async function readImageResponseBody(response, lifetime, limit) {
	lifetime.signal.throwIfAborted();
	if (!response.body) throw new Error('Empty image response');
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0, complete = false;
	try {
		if (Number(response.headers.get('content-length')) > limit) throw new Error('Image response too large');
		while (true) {
			const { done, value } = await waitForSignal(reader.read(), lifetime.signal);
			if (done) { complete = true; break; }
			size += value.byteLength;
			if (size > limit) throw new Error('Image response too large');
			lifetime.touch();
			chunks.push(value);
		}
		return Buffer.concat(chunks, size);
	} finally {
		if (!complete) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

const imageChatModelPattern = /^qwen-image(?:-[\w.]+)*$/i;

function isImageChatModel(model) {
	return typeof model === 'string' && imageChatModelPattern.test(model.trim());
}

// Image chats arrive as regular chat completions; only the last user message is
// the prompt, while system prompts and tool priming are ignored.
function extractImagePrompt(messages) {
	if (!Array.isArray(messages)) return '';
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role !== 'user') continue;
		if (typeof message.content === 'string') return message.content.trim();
		if (Array.isArray(message.content)) {
			const text = message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim();
			return text;
		}
		return '';
	}
	return '';
}

function detectImageMimeType(bytes) {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
	if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
	return undefined;
}

function activate(context) {
	const output = vscode.window.createOutputChannel('GENAI Login');
	context.subscriptions.push(output);
	const trace = message => output.appendLine(`${new Date().toISOString()} ${message}`);
	let history;
	const getHistory = () => {
		if (!history) {
			const files = context.globalStorageUri ? createHistoryFiles(vscode.workspace.fs,
				vscode.Uri.joinPath(context.globalStorageUri, 'usage-history'), vscode.Uri.joinPath,
				() => trace('An unreadable history record was preserved and skipped; other totals remain available.')) : undefined;
			history = createHistory(context.globalState, () => trace('History storage unavailable; totals may be incomplete or fail to survive reload.'), files);
		}
		return history;
	};
	let server, listenerController, listenerReady = false, listenerStartPromise, requestHandler, connectPromise;
	let connectionVersion = 0, automaticLoginBlocked = false;
	let automaticRetryAt = 0, automaticFailures = 0;
	let active, authentication, keepaliveTimer, keepaliveOwner, reconnectActive;
	let state = 'Disconnected';
	let connection = 'disconnected', loginPhase;
	const pendingActions = new Map();
	let dashboard;
	let sharedState, syncInFlight, syncDisposed = false;
	let syncController = new AbortController();
	let syncTimer;
	let keepaliveInfo = { state: 'idle', lastCheckAt: null };
	let sessionPersistence, sessionPersistenceInfo = 'idle';
	const configuredPort = vscode.workspace.getConfiguration('genai-login').get('port', 58379);
	const stats = createStats(Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535 ? configuredPort : 58379);
	let admission;
	const getAdmission = () => {
		if (!admission) {
			const configuration = vscode.workspace.getConfiguration('genai-login');
			const bounded = (name, fallback, minimum, maximum) => {
				const value = configuration.get(name, fallback);
				return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
			};
			admission = createBridgeAdmission({ maxActive: bounded('maxConcurrentRequests', 32, 1, 256),
				maxQueued: bounded('maxQueuedRequests', 64, 0, 1024),
				maxBytes: bounded('maxBufferedRequestMiB', 128, 40, 2048) * 1024 * 1024,
				queueTimeoutMs: bounded('queueTimeoutSeconds', 60, 1, 600) * 1000 });
		}
		return admission;
	};
	const imageMcpEnabled = () => vscode.workspace.getConfiguration('genai-login').get('imageMcp.enabled', false);
	const mcpChanges = vscode.lm?.registerMcpServerDefinitionProvider ? new vscode.EventEmitter() : undefined;
	if (mcpChanges) {
		context.subscriptions.push(mcpChanges, vscode.lm.registerMcpServerDefinitionProvider('genai-login.drawing', {
			onDidChangeMcpServerDefinitions: mcpChanges.event,
			provideMcpServerDefinitions: () => imageMcpEnabled() ? [new vscode.McpHttpServerDefinition(
				'GENAI / Qwen Image 2.1', vscode.Uri.parse(`http://127.0.0.1:${stats.port}/mcp`),
				{ Authorization: 'Bearer local-browser-session' }, '1.0.0')] : []
		}), vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('genai-login.imageMcp.enabled')) mcpChanges.fire();
		}));
	}
	let dispatcher;
	context.subscriptions.push({ dispose: () => { void dispatcher?.destroy().catch(() => {}); } });
	const status = value => {
		state = value;
		connection = value.startsWith('Connected') ? 'connected' : value === 'Authenticating' ? 'authenticating' : value === 'Connecting' ? 'connecting' : value === 'Disconnected' ? 'disconnected' : 'error';
		if (connection !== 'authenticating') loginPhase = undefined;
		dashboard?.refresh();
	};
	const localSnapshot = () => ({
		status: state,
		connection, loginPhase, active: Boolean(active), listening: listenerReady, shared: false,
		pendingActions: [...pendingActions.keys()],
		bridge: admission?.snapshot(),
		history: context.globalStorageUri && (!history || history.state() !== 'ready') ? undefined : getHistory().snapshot(),
		historyState: history?.state() || (context.globalStorageUri ? 'loading' : 'ready'),
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
		keepalive: { ...keepaliveInfo },
		sessionPersistence: sessionPersistenceInfo
	});
	const stateSnapshot = () => {
		const local = localSnapshot();
		if (active || !sharedState) return local;
		const remoteHistory = sharedState.history;
		const useRemoteHistory = remoteHistory && sharedState.historyState !== 'loading' && sharedState.historyState !== 'error' &&
			(!local.history || ['requests', 'tokensIn', 'tokensOut'].every(field => Number(remoteHistory[field] || 0) >= Number(local.history[field] || 0)) &&
				['requests', 'tokensIn', 'tokensOut'].some(field => Number(remoteHistory[field] || 0) > Number(local.history[field] || 0)));
		return { ...sharedState, shared: true, pendingActions: [...pendingActions.keys()], status: `${sharedState.status} (shared window)`,
			history: useRemoteHistory ? remoteHistory : local.history,
			historyState: useRemoteHistory ? 'ready' : local.historyState };
	};
	const syncSharedState = () => {
		if (syncDisposed || active || listenerReady) return Promise.resolve();
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
				if (!syncDisposed && !active && !listenerReady && !currentController.signal.aborted) { sharedState = next; dashboard?.refresh(); }
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
		const refreshHistory = () => { if (!syncDisposed) dashboard?.refresh(); };
		void getHistory().reload(refreshHistory).then(refreshHistory);
		if (active || listenerReady) return;
		void syncSharedState();
		syncTimer = setInterval(() => { void syncSharedState(); }, 2000);
		syncTimer.unref?.();
	};
	const requireOwner = async () => {
		if (!active && !listenerReady) await syncSharedState();
		if (!active && sharedState) {
			await vscode.window.showInformationMessage('GENAI is connected in another VS Code window. Manage the connection in that window.');
			return false;
		}
		return true;
	};
	const sendError = (response, code, message, headers = {}) => { response.writeHead(code, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify({ error: { message } })); };
	const temporaryAuthenticationFailure = error => error.retryAuthentication !== false &&
		(error.code === 'SESSION_UNAVAILABLE' && [429, 502, 503, 504].includes(error.status) ||
			error.code === 'SESSION_CHECK_TIMEOUT' ||
			error.retryAuthentication === true && error.name === 'TimeoutError' ||
		['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
			'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_NETWORK_CHANGED', 'ERR_CONNECTION_TIMED_OUT'].includes(transportCode(error)));
	const automaticRetryHeaders = () => automaticRetryAt > Date.now() ?
		{ 'retry-after': String(Math.max(1, Math.ceil((automaticRetryAt - Date.now()) / 1000))) } : {};
	const rejectLocalRequest = request => {
		const fetchSite = request.headers['sec-fetch-site'];
		return request.headers.host !== `127.0.0.1:${stats.port}` ? 'host mismatch' : request.headers.origin ? 'Origin present' : fetchSite !== undefined && fetchSite !== 'none' ? `Fetch Metadata rejected (${['same-origin', 'same-site', 'cross-site'].includes(fetchSite) ? fetchSite : 'unrecognized'})` : request.headers.authorization !== 'Bearer local-browser-session' ? (request.headers.authorization ? 'Authorization mismatch' : 'Authorization missing') : '';
	};
	const startListener = async () => {
		if (listenerReady) return true;
		if (listenerStartPromise) return listenerStartPromise;
		const operation = (async () => {
			const owner = new AbortController();
			listenerController = owner;
			const candidate = http.createServer((request, response) => {
				void (async () => {
					const rejected = rejectLocalRequest(request);
					if (rejected) { trace(`Local request rejected: ${rejected}`); return sendError(response, 403, `Local authenticated clients only: ${rejected}`); }
					if (request.method === 'GET' && request.url === '/internal/status') {
						response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
						return response.end(JSON.stringify({ service: 'genai-login', version: 1, state: localSnapshot() }));
					}
					if (request.url === '/mcp') {
						if (!imageMcpEnabled()) return sendError(response, 404, 'Drawing MCP is disabled');
						return require('./image-mcp').handleImageMcp(request, response, {
							port: stats.port, directory: context.globalStorageUri?.fsPath, signal: owner.signal, detectImageMimeType
						});
					}
					const supported = request.method === 'POST' && ['/v1/chat/completions', '/v1/images/generations'].includes(request.url) || request.method === 'GET' && request.url === '/v1/models';
					if (!supported) return sendError(response, 404, 'Not found');
					if (automaticLoginBlocked) return sendError(response, 401, 'GENAI verification did not complete; reconnect explicitly before retrying.');
					if (!requestHandler && automaticRetryAt > Date.now()) return sendError(response, 503,
						'GENAI automatic connection is cooling down after a temporary network or service failure; retry later or reconnect explicitly.', automaticRetryHeaders());
					const contentLength = request.headers['content-length'];
					const declaredBytes = typeof contentLength === 'string' && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined;
					if (declaredBytes > MAX_JSON_REQUEST_BODY) return sendError(response, 413, 'Request too large');
					const bodyBudget = Number.isSafeInteger(declaredBytes) ? declaredBytes : request.method === 'GET' && !request.headers['transfer-encoding'] ? 0 : MAX_JSON_REQUEST_BODY;
					const queuedLifetime = createRequestLifetime(response, owner.signal);
					const cancelQueued = () => request.destroy();
					queuedLifetime.signal.addEventListener('abort', cancelQueued, { once: true });
					let permit;
					try {
						permit = await getAdmission().acquire(bodyBudget * 2, queuedLifetime.signal);
						queuedLifetime.signal.throwIfAborted();
						if (automaticLoginBlocked) return sendError(response, 401, 'GENAI verification did not complete; reconnect explicitly before retrying.');
						if (!requestHandler && automaticRetryAt > Date.now()) return sendError(response, 503,
							'GENAI automatic connection is cooling down after a temporary network or service failure; retry later or reconnect explicitly.', automaticRetryHeaders());
						if (!requestHandler) {
							try {
								await waitForSignal(connect(false, true), queuedLifetime.signal);
								queuedLifetime.signal.throwIfAborted();
							} catch (error) {
								if (queuedLifetime.signal.aborted) return;
								if (!response.destroyed && !response.headersSent) sendError(response, 503, error.code === 'SESSION_CHECK_TIMEOUT' && !automaticLoginBlocked ?
									'GENAI session check timed out; retry the request. Automatic connection remains enabled.' :
									`GENAI automatic connection failed (${transportCode(error)}); retry after the cooldown or reconnect explicitly.`, automaticRetryHeaders());
								return;
							}
						}
						if (!requestHandler) return sendError(response, 503, 'GENAI is not connected; retry after saving credentials.');
						queuedLifetime.signal.removeEventListener('abort', cancelQueued);
						queuedLifetime.dispose();
						try {
							await requestHandler(request, response, permit);
						} catch (error) {
							trace(`Proxy failed: code=${transportCode(error)}`);
							if (response.destroyed) return;
							if (!response.headersSent) sendError(response, 502, 'Upstream request failed. Retry when network is available.');
							else response.destroy();
						}
					} catch (error) {
						if (queuedLifetime.signal.aborted || response.destroyed) return;
						if (['BRIDGE_BUSY', 'BRIDGE_QUEUE_TIMEOUT'].includes(error.code)) {
							trace(`Local bridge admission rejected: code=${error.code}`);
							return sendError(response, 503, error.message, { 'retry-after': '1' });
						}
						throw error;
					} finally {
						permit?.release();
						queuedLifetime.signal.removeEventListener('abort', cancelQueued);
						queuedLifetime.dispose();
					}
				})().catch(error => {
					trace(`Local request failed: code=${transportCode(error)}`);
					if (!response.destroyed && !response.headersSent) sendError(response, 502, 'GENAI request failed.');
				});
			});
			server = candidate;
			try {
				await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(stats.port, '127.0.0.1', resolve); });
				if (owner.signal.aborted || server !== candidate || syncDisposed) { candidate.close(); return false; }
				listenerReady = true;
				sharedState = undefined;
				clearInterval(syncTimer); syncTimer = undefined;
				trace(`Local bridge listener ready on 127.0.0.1:${stats.port}`);
				dashboard?.refresh();
				return true;
			} catch (error) {
				if (server === candidate) server = undefined;
				candidate.closeAllConnections?.(); candidate.close?.();
				if (owner.signal.aborted || syncDisposed) return false;
				if (error.code === 'EADDRINUSE') { await syncSharedState(); if (sharedState) return false; }
				throw error;
			}
		})();
		listenerStartPromise = operation;
		try { return await operation; } finally { if (listenerStartPromise === operation) listenerStartPromise = undefined; }
	};
	const stop = (closeListener = true) => {
		connectionVersion++;
		active?.abort(); active = undefined; authentication = undefined;
		reconnectActive = undefined;
		connectPromise = undefined;
		requestHandler = undefined;
		automaticLoginBlocked = false;
		pendingActions.delete('connect'); pendingActions.delete('diagnose');
		clearTimeout(keepaliveTimer); keepaliveTimer = undefined; keepaliveOwner = undefined;
		keepaliveInfo = { state: 'idle', lastCheckAt: null };
		sessionPersistenceInfo = 'idle';
		if (closeListener) {
			automaticRetryAt = 0; automaticFailures = 0;
			listenerController?.abort(); listenerController = undefined; listenerStartPromise = undefined;
			server?.closeAllConnections(); server?.close(); server = undefined; listenerReady = false;
		}
		stats.connectedAt = null; stats.requests = 0; stats.tokensIn = 0; stats.tokensOut = 0; stats.usageReports = 0; stats.usageMissing = 0; stats.models.clear(); stats.otherModels = 0;
		stats.inputUsageReports = 0; stats.outputUsageReports = 0;
		stats.modelUsage.clear();
		status('Disconnected');
	};
	stopActive = stop;
	const credentials = async () => {
		if (!await requireOwner()) return false;
		if (active) throw new Error('Disconnect before changing credentials.');
		const version = connectionVersion;
		const username = await vscode.window.showInputBox({ title: 'UMPASS account', prompt: 'Full UMPASS login name', ignoreFocusOut: true });
		if (!username) return false;
		const password = await vscode.window.showInputBox({ title: 'UMPASS password', password: true, ignoreFocusOut: true });
		if (!password) return false;
		if (!await requireOwner()) return false;
		if (active) throw new Error('Disconnect before changing credentials.');
		if (version !== connectionVersion || syncDisposed) return false;
		await context.secrets.store('credentials', JSON.stringify({ username, password }));
		await sessionPersistence?.flush();
		await context.secrets.delete('session');
		return true;
	};
	const connectNow = async (diagnostic = false, automatic = false) => {
		if (active) return;
		if (!automatic) { automaticLoginBlocked = false; automaticRetryAt = 0; automaticFailures = 0; }
		const version = connectionVersion;
		if (!await startListener() || version !== connectionVersion || syncDisposed) return;
		await getHistory().reload();
		if (active || sharedState || version !== connectionVersion || syncDisposed) return;
		if (diagnostic) output.show(true);
		trace(diagnostic ? 'Visible diagnostic connection requested' : automatic ? 'Automatic connection requested' : 'Manual connection requested');
		let stored = await context.secrets.get('credentials');
		if (version !== connectionVersion || syncDisposed) return;
		if (!stored) { if (!await credentials()) return; stored = await context.secrets.get('credentials'); }
		if (active || version !== connectionVersion || syncDisposed) return;
		const controller = new AbortController(); active = controller;
		try {
		status('Connecting');
		const { Agent, fetch: upstreamFetch } = require('./upstream');
		const { Session, createKeepaliveSchedule, createSessionPersistence, ORIGIN } = require('./auth');
		const { browserLogin: login } = require('./browser-auth');
		dispatcher ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
		keepaliveOwner = controller;
		let keepaliveInFlight = false;
		const account = JSON.parse(stored);
		let session, savedSession;
		try { savedSession = await context.secrets.get('session'); session = new Session(savedSession, trace); } catch { savedSession = undefined; trace('Saved cookie jar unavailable; starting fresh'); session = new Session(undefined, trace); }
		if (controller.signal.aborted) return;
		const isCurrentConnection = () => keepaliveOwner === controller && active === controller && !controller.signal.aborted;
		const keepaliveSchedule = createKeepaliveSchedule(session);
		sessionPersistenceInfo = 'idle';
		const persistence = createSessionPersistence(session, context.secrets, isCurrentConnection, value => {
			if (value === 'error' && sessionPersistenceInfo !== 'error') trace('Session persistence failed; live requests continue, but reload may require login.');
			sessionPersistenceInfo = value; dashboard?.refresh();
		}, Boolean(savedSession));
		sessionPersistence = persistence;
		const persist = () => persistence.save();
		let retainedBrowser, reauthenticationBlocked = false;
		let authenticationRetryAt = 0, authenticationFailures = 0, sessionVersion = 0;
		let healthFailures = 0, healthRecoveryAttempted = false;
		const retryHeaders = () => ({ 'retry-after': String(Math.max(1, Math.ceil((authenticationRetryAt - Date.now()) / 1000))) });
		const sendAuthenticationError = response => sendError(response, reauthenticationBlocked ? 401 : 503, reauthenticationBlocked ?
			'Automatic login failed; reconnect after checking credentials or verification.' :
			'GENAI authentication is recovering; retry after the cooldown.', reauthenticationBlocked ? {} : retryHeaders());
		const loginTrace = message => {
			trace(message);
			if (!isCurrentConnection()) return;
			const phase = message === 'Checking saved session' ? 'checking-session' : message.startsWith('Starting temporary') ? 'opening-browser' :
				message === 'Opening GENAI home page' || message === 'Waiting for GENAI sign-in page' || message.startsWith('GENAI login page returned') ? 'webui-entry' :
				message === 'Filling verified UMPASS login form' ? 'credentials' : message.startsWith('Waiting for Duo') || message.startsWith('Credentials submitted') ? 'mfa' :
				message.startsWith('Waiting for UMPASS') ? 'umpass' : message === 'Checking GENAI callback' ? 'callback' : message === 'Waiting for identity redirect' ? 'redirect' : undefined;
			if (phase && loginPhase !== phase) { loginPhase = phase; dashboard?.refresh(); }
		};
		const authenticate = (force = false) => {
			if (!authentication) {
				loginPhase = 'checking-session';
				status('Authenticating');
				authentication = (async () => {
					await retainedBrowser?.(); retainedBrowser = undefined;
					retainedBrowser = await login(session, account, controller.signal, loginTrace, undefined, diagnostic, !diagnostic,
						{ force: true });
					controller.signal.throwIfAborted();
					if (active !== controller) return;
					sessionVersion++;
					authenticationRetryAt = 0;
					authenticationFailures = 0;
					healthFailures = 0;
					void persist();
					if (!isCurrentConnection()) return;
					keepaliveSchedule.checked();
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					stats.connectedAt ??= Date.now(); trace('Authenticated; session persistence scheduled'); status(`Connected :${stats.port}`);
				})().catch(error => {
					if (force && isCurrentConnection()) {
						if (temporaryAuthenticationFailure(error) && ++authenticationFailures <= 2) {
							keepaliveSchedule.failed(error.retryAfterMs);
							authenticationRetryAt = keepaliveSchedule.snapshot().nextCheckAt;
							keepaliveInfo = { state: 'retrying', lastCheckAt: Date.now() };
							trace(`Authentication: temporary failure code=${transportCode(error)} status=${error.status || 'unknown'}; recovery retry ${authenticationFailures}/2 scheduled`);
							status('Connection interrupted; retrying');
						} else {
							reauthenticationBlocked = true;
							keepaliveInfo = { state: 'needs-login', lastCheckAt: Date.now(), nextCheckAt: null };
							status('Authentication required; reconnect');
						}
					}
					throw error;
				}).finally(() => { if (active === controller) { authentication = undefined; if (!keepaliveInFlight) scheduleKeepalive(); } });
			}
			return authentication;
		};
		reconnectActive = async () => {
			if (!isCurrentConnection() || authentication) return authentication;
			trace('Manual recovery requested; preserving listener and active streams');
			reauthenticationBlocked = false;
			authenticationRetryAt = 0;
			authenticationFailures = 0;
			healthFailures = 0;
			healthRecoveryAttempted = false;
			try { await authenticate(true); } catch (error) { await reportError(error); }
		};
		const scheduleKeepalive = () => {
			if (!isCurrentConnection()) return;
			clearTimeout(keepaliveTimer);
			keepaliveTimer = undefined;
			if (authentication || reauthenticationBlocked) return;
			const plan = keepaliveSchedule.snapshot();
			const milliseconds = Math.max(0, plan.nextCheckAt - Date.now());
			keepaliveInfo = { ...keepaliveInfo, nextCheckAt: plan.nextCheckAt, expiresAt: plan.expiresAt, expiring: plan.expiring };
			keepaliveTimer = setTimeout(runKeepalive, milliseconds);
			keepaliveTimer.unref?.();
		};
		const runKeepalive = async () => {
			if (!isCurrentConnection() || keepaliveInFlight) return;
			if (authentication || reauthenticationBlocked) return;
			const activityVersion = keepaliveSchedule.snapshot().activityVersion;
			const checkedSessionVersion = sessionVersion;
			keepaliveInFlight = true;
			keepaliveInfo = { state: 'checking', lastCheckAt: Date.now() };
			dashboard?.refresh();
			try {
				if (authenticationRetryAt) {
					await authenticate(true);
					return;
				}
				let valid;
				try {
					valid = await session.valid(AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
				} catch (error) {
					if (!isCurrentConnection()) return;
					if (checkedSessionVersion !== sessionVersion) return;
					if (activityVersion !== keepaliveSchedule.snapshot().activityVersion) throw error;
					healthFailures++;
					if (healthFailures < 3 || healthRecoveryAttempted || !(temporaryAuthenticationFailure(error) || error.name === 'TimeoutError') ||
						error.status === 429 || error.retryAfterMs > 0) throw error;
					if (authenticationRetryAt > Date.now()) throw error;
					healthRecoveryAttempted = true;
					trace('Keepalive: repeated session checks unavailable; attempting one browser recovery');
					await authenticate(true);
					return;
				}
				if (!isCurrentConnection()) return;
				if (checkedSessionVersion !== sessionVersion || activityVersion !== keepaliveSchedule.snapshot().activityVersion) {
					keepaliveSchedule.checked();
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					trace('Keepalive: stale check ignored after newer authentication or successful upstream activity');
					return;
				}
				if (valid) {
					healthFailures = 0;
					healthRecoveryAttempted = false;
					authenticationRetryAt = 0;
					authenticationFailures = 0;
					void persist();
					keepaliveSchedule.checked();
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					status(`Connected :${stats.port}`);
					trace('Keepalive: session valid');
				} else {
					keepaliveInfo = { state: 'reauthenticating', lastCheckAt: Date.now() };
					dashboard?.refresh();
					trace('Keepalive: authentication endpoint rejected the session; reauthenticating');
					await authenticate(true);
					if (!isCurrentConnection()) return;
					void persist();
					keepaliveSchedule.checked();
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					trace('Keepalive: reauthenticated');
				}
			} catch (error) {
				if (isCurrentConnection()) {
					if (reauthenticationBlocked) {
						trace(`Keepalive: reauthentication failed code=${transportCode(error)}; manual reconnect required, active streams preserved`);
						void reportError(error);
						return;
					}
					if (authenticationRetryAt > Date.now()) {
						trace('Keepalive: temporary reauthentication failure; waiting for recovery cooldown');
						return;
					}
					const recentSuccess = activityVersion !== keepaliveSchedule.snapshot().activityVersion;
					if (recentSuccess && !error.retryAfterMs) keepaliveSchedule.checked(); else keepaliveSchedule.failed(error.retryAfterMs);
					keepaliveInfo = { state: recentSuccess ? 'healthy' : 'error', lastCheckAt: Date.now() };
					trace(`Keepalive: temporary failure code=${transportCode(error)} status=${Number.isInteger(error.status) ? error.status : 'unknown'} recentSuccess=${recentSuccess}; no reauthentication`);
				}
			}
			finally {
				keepaliveInFlight = false;
				if (isCurrentConnection()) { scheduleKeepalive(); dashboard?.refresh(); }
			}
		};
		const startKeepalive = () => { clearTimeout(keepaliveTimer); scheduleKeepalive(); };
		const noteActivity = (authenticated = true) => {
			if (!isCurrentConnection()) return;
			keepaliveSchedule.activity(authenticated);
			if (authenticated) { healthFailures = 0; healthRecoveryAttempted = false; authenticationRetryAt = 0; authenticationFailures = 0; }
			if (!keepaliveInFlight && !reauthenticationBlocked && !authenticationRetryAt) keepaliveInfo = { state: 'healthy', lastCheckAt: keepaliveInfo.lastCheckAt };
			scheduleKeepalive();
		};
		const downloadPlatformImage = async (url, lifetime, limit) => {
			const target = new URL(url, ORIGIN);
			if (target.origin !== ORIGIN || target.username || target.password || !/^\/api\/v1\/files\/[^/]+\/content$/.test(target.pathname)) throw new Error('Untrusted image file reference');
			const image = await session.request(target.href, { signal: lifetime.signal, fetch: upstreamFetch, dispatcher, checkSession: true });
			lifetime.touch();
			if (!image.ok || !image.body) { await image.body?.cancel(); throw new Error(`Image file download failed with HTTP ${image.status}`); }
			return readImageResponseBody(image, lifetime, limit);
		};
		const settleRequest = requestStats => {
			getHistory().finish(requestStats);
			if (active !== controller || controller.signal.aborted) return;
			if (commitRequest(stats, requestStats)) dashboard?.refresh();
		};
		const handle = async (request, response, permit) => {
			const route = request.method === 'POST' && request.url === '/v1/chat/completions' ? '/api/v1/chat/completions'
				: request.method === 'POST' && request.url === '/v1/images/generations' ? '/api/v1/images/generations'
					: request.method === 'GET' && request.url === '/v1/models' ? '/api/v1/models' : null;
			if (!route) return sendError(response, 404, 'Not found');
			const lifetime = createRequestLifetime(response, controller.signal);
			const cancelRequest = () => request.destroy();
			lifetime.signal.addEventListener('abort', cancelRequest, { once: true });
			const startedAt = Date.now();
			const bodyBudget = permit ? permit.bytes / 2 : MAX_JSON_REQUEST_BODY;
			let bytes = 0;
			let requestStats, usageParser;
			try {
			if (reauthenticationBlocked) return sendAuthenticationError(response);
			if (authentication) {
				try { await waitForSignal(authentication, lifetime.signal); } catch (error) {
					if (lifetime.signal.aborted) throw error;
					return sendAuthenticationError(response);
				}
			}
			lifetime.signal.throwIfAborted();
			if (authenticationRetryAt > Date.now()) return sendError(response, 503, 'GENAI authentication is recovering; retry after the cooldown.', retryHeaders());
			const chunks = []; let size = 0;
			for await (const chunk of request) {
				lifetime.signal.throwIfAborted(); size += chunk.length;
				if (size > MAX_JSON_REQUEST_BODY || request.method === 'POST' && size > bodyBudget) return sendError(response, 413, 'Request too large');
				if (request.method === 'POST') chunks.push(chunk);
			}
			lifetime.signal.throwIfAborted();
			const idleSeconds = vscode.workspace.getConfiguration('genai-login').get('idleTimeoutSeconds', 0);
			const idleMs = Number.isInteger(idleSeconds) && idleSeconds >= 0 && idleSeconds <= 86400 ? idleSeconds * 1000 : 0;
			lifetime.setIdleTimeout(idleMs);
			const options = { method: request.method, body: request.method === 'POST' ? chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size) : undefined, headers: { 'content-type': 'application/json', Accept: 'application/json' }, signal: lifetime.signal, fetch: upstreamFetch, dispatcher };
			chunks.length = 0;
			permit?.shrink(options.body?.length || 0);
			let requestPayload = request.method === 'POST' ? parseRequestBody(options.body) : undefined;
			if (request.method === 'POST') {
				requestStats = recordRequest(stats, options.body, startedAt, requestPayload);
				getHistory().start();
				dashboard?.refresh();
			}
			const forwardUpstream = async (routePath, requestOptions) => {
				const version = sessionVersion;
				let result = await session.request(ORIGIN + routePath, requestOptions);
				if (result.status !== 401) return result;
				await result.body?.cancel();
				if (reauthenticationBlocked) { sendAuthenticationError(response); return undefined; }
				if (authenticationRetryAt > Date.now()) {
					sendError(response, 503, 'GENAI authentication is recovering; retry after the cooldown.', retryHeaders());
					return undefined;
				}
				trace(version === sessionVersion ? 'Proxy: authentication rejected with HTTP 401; attempting one login before forwarding' : 'Proxy: stale HTTP 401 from previous session; retrying with the refreshed session');
				lifetime.setIdleTimeout(0);
				try { if (authentication || version === sessionVersion) await waitForSignal(authentication || authenticate(true), lifetime.signal); } catch (error) {
					if (lifetime.signal.aborted) throw error;
					sendAuthenticationError(response);
					return undefined;
				}
				lifetime.signal.throwIfAborted();
				lifetime.setIdleTimeout(idleMs);
				return session.request(ORIGIN + routePath, requestOptions);
			};
			if (route === '/api/v1/chat/completions') {
				if (requestPayload && isImageChatModel(requestPayload.model)) {
					const prompt = extractImagePrompt(requestPayload.messages);
					if (!prompt) return sendError(response, 400, 'The image model requires a text prompt in the last user message');
					const imagePayload = { prompt, n: Number.isInteger(requestPayload.n) && requestPayload.n >= 1 && requestPayload.n <= 6 ? requestPayload.n : 1 };
					if (typeof requestPayload.size === 'string' && /^\d{1,5}x\d{1,5}$/.test(requestPayload.size)) imagePayload.size = requestPayload.size;
					const imageResult = await forwardUpstream('/api/v1/images/generations', { method: 'POST', body: Buffer.from(JSON.stringify(imagePayload)), headers: { 'content-type': 'application/json', Accept: 'application/json' }, signal: lifetime.signal, fetch: upstreamFetch, dispatcher });
					if (!imageResult) return;
					lifetime.touch();
					void persist();
					if (!imageResult.ok) {
						response.writeHead(imageResult.status, proxyResponseHeaders(imageResult.headers));
						if (!imageResult.body) return response.end();
						await forwardBody(imageResult.body, response, lifetime, chunk => { bytes += chunk.length; });
						trace(`Proxy completed: status=${imageResult.status} elapsedMs=${Date.now() - startedAt} bytes=${bytes} image=chat`);
						return;
					}
					noteActivity();
					let platformPayload;
					const platformBody = await readImageResponseBody(imageResult, lifetime, 1024 * 1024);
					try { platformPayload = JSON.parse(platformBody.toString('utf8')); } catch { platformPayload = undefined; }
					const generated = await convertImageResponse(platformPayload, (url, limit) => downloadPlatformImage(url, lifetime, limit));
					if (!generated.length) return sendError(response, 502, 'Image generation did not return a downloadable image');
					const content = generated.map(image => `![Qwen-Image](data:${detectImageMimeType(Buffer.from(image.b64_json, 'base64'))};base64,${image.b64_json})`).join('\n\n');
					const created = Math.floor(Date.now() / 1000);
					const id = `chatcmpl-image-${created}`;
					const usage = null;
					if (requestPayload.stream) {
						const { Readable } = require('node:stream');
						response.writeHead(200, proxyResponseHeaders(imageResult.headers, 'text/event-stream'));
						const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestPayload.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
						function* events() {
							yield Buffer.from(chunk({ role: 'assistant', content: '' }));
							for (let offset = 0; offset < content.length; offset += 65536) yield Buffer.from(chunk({ content: content.slice(offset, offset + 65536) }));
							yield Buffer.from(chunk({}, 'stop'));
							if (requestPayload.stream_options?.include_usage) yield Buffer.from(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestPayload.model, choices: [], usage })}\n\n`);
							yield Buffer.from('data: [DONE]\n\n');
						}
						await forwardBody(Readable.toWeb(Readable.from(events(), { objectMode: false })), response, lifetime, chunk => { bytes += chunk.length; });
						trace(`Proxy completed: status=200 elapsedMs=${Date.now() - startedAt} bytes=${bytes} image=chat stream=true`);
						return;
					}
					const body = Buffer.from(JSON.stringify({ id, object: 'chat.completion', created, model: requestPayload.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
					response.writeHead(200, proxyResponseHeaders(imageResult.headers, 'application/json'));
					trace(`Proxy completed: status=200 elapsedMs=${Date.now() - startedAt} bytes=${body.length} image=chat`);
					return response.end(body);
				}
			}
			requestPayload = undefined;
			const result = await forwardUpstream(route, options);
			if (!result) return;
			lifetime.touch();
			void persist();
			const contentType = result.headers.get('content-type') || 'application/json';
			const sessionAccepted = result.ok && /application\/json|text\/event-stream/i.test(contentType);
			if (sessionAccepted) noteActivity();
			if (isCurrentConnection() && !authentication && !reauthenticationBlocked && !authenticationRetryAt) status(`Connected :${stats.port}`);
			if (route === '/api/v1/images/generations' && result.ok) {
				let payload;
				const platformBody = await readImageResponseBody(result, lifetime, 1024 * 1024);
				try { payload = JSON.parse(platformBody.toString('utf8')); } catch { payload = undefined; }
				const data = await convertImageResponse(payload, (url, limit) => downloadPlatformImage(url, lifetime, limit));
				if (!data.length) return sendError(response, 502, 'Image generation did not return a downloadable image');
				const body = Buffer.from(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }));
				response.writeHead(200, proxyResponseHeaders(result.headers, 'application/json'));
				trace(`Proxy completed: status=200 elapsedMs=${Date.now() - startedAt} bytes=${body.length} images=${data.length}`);
				return response.end(body);
			}
			response.writeHead(result.status, proxyResponseHeaders(result.headers, contentType));
			if (!result.body) { settleRequest(requestStats); return response.end(); }
			usageParser = createUsageParser(contentType, requestStats);
			const normalizeStream = result.status === 200 && contentType.toLowerCase().includes('text/event-stream');
			await forwardBody(result.body, response, lifetime, chunk => {
				bytes += chunk.length;
				if (!normalizeStream) usageParser.consume(chunk);
				if (sessionAccepted && Date.now() - keepaliveSchedule.lastActivityAt() >= 15000) noteActivity(false);
			}, normalizeStream, usageParser.consumeEvent);
			if (sessionAccepted) noteActivity(false);
			trace(`Proxy completed: status=${result.status} elapsedMs=${Date.now() - startedAt} bytes=${bytes}`);
			} catch (error) {
				const reason = lifetime.signal.reason?.name === 'TimeoutError' ? lifetime.signal.reason : error;
				trace(`Proxy failed: code=${transportCode(reason)} elapsedMs=${Date.now() - startedAt} bytes=${bytes} cancelled=${lifetime.signal.aborted}`);
				throw error;
			} finally {
				lifetime.signal.removeEventListener('abort', cancelRequest);
				lifetime.dispose();
				usageParser?.finish();
				if (usageParser) trace(`Proxy formatting: ${JSON.stringify(usageParser.formatting)}`);
				settleRequest(requestStats);
			}
		};
			await authenticate();
			if (!isCurrentConnection()) return;
			automaticRetryAt = 0; automaticFailures = 0;
			requestHandler = handle;
			startKeepalive();
		} catch (error) {
			if (controller.signal.aborted) return;
			trace(`Connection failed: code=${transportCode(error)}; inspect preceding stage (no credentials logged)`); output.show(true);
			if (active === controller) stop(false);
			if (automatic && (error.retryAuthentication === false ||
				error.name === 'TimeoutError' && error.retryAuthentication !== true || error.code === 'CREDENTIALS_REJECTED')) {
				automaticLoginBlocked = true;
				keepaliveInfo = { state: 'needs-login', lastCheckAt: Date.now() };
				status('Authentication required; reconnect');
			} else if (error.code === 'SESSION_CHECK_TIMEOUT') {
				keepaliveInfo = { state: 'error', reason: 'session-check-timeout', lastCheckAt: Date.now() };
				status('Session check timed out; retry available');
				trace('Initial session check timed out; automatic connection remains available for the next request');
			}
			if (automatic && !automaticLoginBlocked && temporaryAuthenticationFailure(error)) {
				const milliseconds = Math.max(Math.min(30000 * 2 ** Math.min(automaticFailures++, 4), 300000), error.retryAfterMs || 0);
				automaticRetryAt = Date.now() + milliseconds;
				keepaliveInfo = { state: 'error', reason: error.code === 'SESSION_CHECK_TIMEOUT' ? 'session-check-timeout' : 'connection-unavailable',
					lastCheckAt: Date.now(), nextCheckAt: automaticRetryAt };
				status(error.code === 'SESSION_CHECK_TIMEOUT' ? 'Session check timed out; retry after cooldown' : 'Connection temporarily unavailable; retry after cooldown');
				trace(`Automatic connection: temporary failure code=${transportCode(error)}; retry available in ${milliseconds}ms`);
			}
			if (error.code === 'EADDRINUSE') { await syncSharedState(); if (sharedState) return; }
			throw error;
		}
	};
	const connect = async (diagnostic = false, automatic = false) => {
		if (connectPromise) return connectPromise;
		if (active) return !automatic && !diagnostic && ['error', 'retrying', 'needs-login'].includes(keepaliveInfo.state) ? reconnectActive?.() : undefined;
		if (automatic && ['credentials', 'clear', 'diagnose'].some(name => pendingActions.has(name))) throw new Error('GENAI configuration is changing; retry after it completes.');
		const pending = automatic ? {} : undefined;
		if (pending) { pendingActions.set('connect', pending); dashboard?.refresh(); }
		const operation = connectNow(diagnostic, automatic);
		connectPromise = operation;
		try { return await operation; } finally {
			if (connectPromise === operation) connectPromise = undefined;
			if (pending && pendingActions.get('connect') === pending) { pendingActions.delete('connect'); dashboard?.refresh(); }
		}
	};
	let configuringModels = false;
	const models = async () => {
		if (configuringModels) return;
		configuringModels = true;
		try { await require('./copilot-config').configureModels(stats.port); }
		finally { configuringModels = false; }
	};
	const mcp = async () => {
		try {
			if (!mcpChanges) throw new Error('当前 VS Code 不支持 MCP provider，请更新桌面版 VS Code。');
			if (!imageMcpEnabled()) await vscode.workspace.getConfiguration('genai-login').update('imageMcp.enabled', true, vscode.ConfigurationTarget.Global);
			void vscode.window.showInformationMessage('已启用 GENAI / Qwen Image 2.1 绘画 MCP。可在 Copilot Agent 中使用 generate_image；首次启动仍需按 VS Code 提示信任服务器。');
		} catch (error) { await vscode.window.showErrorMessage(`GENAI 绘画 MCP 配置失败：${error.message}`); }
	};
	const port = async () => {
		try {
			const configuration = vscode.workspace.getConfiguration('genai-login');
			const value = await vscode.window.showInputBox({
				title: '设置 GENAI Login 端口',
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
	const actions = { connect, diagnose, credentials, models, mcp, port, disconnect: async () => { if (await requireOwner()) stop(); }, clear: async () => {
		if (!await requireOwner()) return;
		const owner = active;
		const answer = await vscode.window.showWarningMessage('清除保存的账号和 Cookie？', { modal: true, detail: '当前连接将断开，账号和 Cookie 将删除。历史用量保留；此操作不会撤销服务器端会话。' }, '清除凭据');
		if (answer !== '清除凭据' || !await requireOwner() || active !== owner) return;
		stop(); await sessionPersistence?.flush(); await context.secrets.delete('credentials'); await context.secrets.delete('session');
	} };
	const reportError = async error => {
		if (error?.name === 'AbortError') return;
		const message = error?.code === 'EADDRINUSE' ? `端口 ${stats.port} 已占用。请关闭其他桥接，或设置另一个端口后重载。` :
			error?.code === 'SESSION_CHECK_TIMEOUT' ? (error.retryAuthentication === false ?
				'GENAI 登录后的会话验证网络超时。为避免重复 MFA，请稍后重新连接；无需清除账号。' :
				'GENAI 会话检查网络超时，自动连接未禁用。请稍后重试请求或重新连接；无需清除账号。') :
			error?.code === 'SESSION_UNAVAILABLE' ? 'GENAI 暂时不可用或请求受限。现有凭据未清除，请稍后重试。' :
			/msedge|executable.*exist|browser.*not found/i.test(error?.message || '') ? '无法启动 Microsoft Edge。请确认 Edge 已安装，再重试连接。' :
			error?.code === 'CREDENTIALS_REJECTED' ? 'UMPASS 未接受登录。请检查账号和密码，再重试。' :
			error?.name === 'TimeoutError' ? '登录等待超时。请确认手机上的 MFA 已完成，或使用可见诊断查看阻塞页面。' :
			/ERR_|UND_ERR|ECONN|ENOTFOUND/.test(transportCode(error)) ? '登录网络连接失败。请检查网络后重试，保存的凭据未清除。' :
			'GENAI 登录未完成。请查看日志中的失败阶段，或使用可见诊断。';
		const choice = await vscode.window.showErrorMessage(message, '查看日志', '可见诊断');
		if (choice === '查看日志') output.show(true);
		if (choice === '可见诊断') { try { await actions.diagnose(); } catch { output.show(true); } }
	};
	for (const [name, action] of Object.entries(actions)) {
		actions[name] = async () => {
			const exclusive = ['connect', 'diagnose', 'credentials', 'clear'];
			if (pendingActions.has(name) || (exclusive.includes(name) && exclusive.some(value => pendingActions.has(value)))) return;
			const operation = {};
			pendingActions.set(name, operation); dashboard?.refresh();
			try { return await action(); } finally { if (pendingActions.get(name) === operation) pendingActions.delete(name); dashboard?.refresh(); }
		};
		context.subscriptions.push(vscode.commands.registerCommand(`genai-login.${name}`, async () => {
			try { await actions[name](); } catch (error) { await reportError(error); }
		}));
	}
	dashboard = new DashboardProvider(stateSnapshot, actions, reportError, setSyncVisible, trace);
	context.subscriptions.push({ dispose: () => { syncDisposed = true; clearInterval(syncTimer); syncController.abort(); } });
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('genai-login.session', dashboard, { webviewOptions: { retainContextWhenHidden: false } }), { dispose: () => dashboard.dispose() }, { dispose: stop });
	return startListener().catch(error => {
		trace(`Local bridge listener unavailable: code=${transportCode(error)}`);
		void reportError(error);
	});
}
function deactivate() { stopActive?.(); }
module.exports = { activate, deactivate };
