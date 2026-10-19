const vscode = require('vscode');
const http = require('node:http');
const { Readable } = require('node:stream');
const { createRequestLifetime, waitForSignal, forwardBody, transportCode } = require('./bridge-stream');
const { dashboardHtml } = require('./dashboard');
const { createStats, createHistory, createHistoryFiles, recordRequest, commitRequest, createUsageParser, modelUsageRows, DEEPSEEK_PRICING } = require('./stats');

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
			chunks.push(Buffer.from(value));
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
	const historyFiles = context.globalStorageUri ? createHistoryFiles(vscode.workspace.fs,
		vscode.Uri.joinPath(context.globalStorageUri, 'usage-history'), vscode.Uri.joinPath,
		() => trace('An unreadable history record was preserved and skipped; other totals remain available.')) : undefined;
	const history = createHistory(context.globalState, () => trace('History storage unavailable; totals may be incomplete or fail to survive reload.'), historyFiles);
	let server, active, authentication, keepaliveTimer, keepaliveOwner;
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
		connection, loginPhase, active: Boolean(active), listening: Boolean(server?.listening), shared: false,
		pendingActions: [...pendingActions.keys()],
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
		keepalive: { ...keepaliveInfo },
		sessionPersistence: sessionPersistenceInfo
	});
	const stateSnapshot = () => !active && sharedState ? { ...sharedState, shared: true, pendingActions: [...pendingActions.keys()], status: `${sharedState.status} (shared window)` } : localSnapshot();
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
		void history.reload().then(() => { if (!syncDisposed) dashboard?.refresh(); });
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
		pendingActions.delete('connect'); pendingActions.delete('diagnose');
		clearTimeout(keepaliveTimer); keepaliveTimer = undefined; keepaliveOwner = undefined;
		keepaliveInfo = { state: 'idle', lastCheckAt: null };
		sessionPersistenceInfo = 'idle';
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
		await sessionPersistence?.flush();
		await context.secrets.delete('session');
		return true;
	};
	const connect = async (diagnostic = false) => {
		if (active) return;
		await syncSharedState();
		if (active || sharedState) return;
		await history.reload();
		if (active || sharedState) return;
		if (diagnostic) output.show(true);
		trace(diagnostic ? 'Visible diagnostic connection requested' : 'Manual connection requested');
		let stored = await context.secrets.get('credentials');
		if (!stored) { if (!await credentials()) return; stored = await context.secrets.get('credentials'); }
		if (active) return;
		const controller = new AbortController(); active = controller;
		try {
		status('Connecting');
		const { Agent, fetch: upstreamFetch } = require('undici');
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
		const loginTrace = message => {
			trace(message);
			if (!isCurrentConnection()) return;
			const phase = message === 'Checking saved session' ? 'checking-session' : message.startsWith('Starting temporary') ? 'opening-browser' :
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
					retainedBrowser = await login(session, account, controller.signal, loginTrace, undefined, diagnostic, !diagnostic, { force });
					controller.signal.throwIfAborted();
					if (active !== controller) return;
					void persist();
					if (!isCurrentConnection()) return;
					keepaliveSchedule.checked();
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					stats.connectedAt ??= Date.now(); trace('Authenticated; session persistence scheduled'); status(`Connected :${stats.port}`);
				})().catch(error => {
					if (force && isCurrentConnection()) {
						reauthenticationBlocked = true;
						keepaliveInfo = { state: 'needs-login', lastCheckAt: Date.now() };
						status('Authentication required; reconnect');
					}
					throw error;
				}).finally(() => { if (active === controller) { authentication = undefined; if (!keepaliveInFlight) scheduleKeepalive(); } });
			}
			return authentication;
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
			keepaliveInFlight = true;
			keepaliveInfo = { state: 'checking', lastCheckAt: Date.now() };
			dashboard?.refresh();
			try {
				const valid = await session.valid(AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
				if (!isCurrentConnection()) return;
				if (activityVersion !== keepaliveSchedule.snapshot().activityVersion) {
					keepaliveSchedule.checked();
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					trace('Keepalive: stale check ignored after successful upstream activity');
					return;
				}
				if (valid) {
					void persist();
					keepaliveSchedule.checked();
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
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
			if (!keepaliveInFlight && !reauthenticationBlocked) keepaliveInfo = { state: 'healthy', lastCheckAt: keepaliveInfo.lastCheckAt };
			scheduleKeepalive();
		};
		const sendError = (response, code, message) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message } })); };
		const downloadPlatformImage = async (url, lifetime, limit) => {
			const target = new URL(url, ORIGIN);
			if (target.origin !== ORIGIN || target.username || target.password || !/^\/api\/v1\/files\/[^/]+\/content$/.test(target.pathname)) throw new Error('Untrusted image file reference');
			const image = await session.request(target.href, { signal: lifetime.signal, fetch: upstreamFetch, dispatcher, checkSession: true });
			lifetime.touch();
			if (!image.ok || !image.body) { await image.body?.cancel(); throw new Error(`Image file download failed with HTTP ${image.status}`); }
			return readImageResponseBody(image, lifetime, limit);
		};
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
			const route = request.method === 'POST' && request.url === '/v1/chat/completions' ? '/api/v1/chat/completions'
				: request.method === 'POST' && request.url === '/v1/images/generations' ? '/api/v1/images/generations'
					: request.method === 'GET' && request.url === '/v1/models' ? '/api/v1/models' : null;
			if (!route) return sendError(response, 404, 'Not found');
			const lifetime = createRequestLifetime(response, controller.signal);
			const cancelRequest = () => request.destroy();
			lifetime.signal.addEventListener('abort', cancelRequest, { once: true });
			const startedAt = Date.now();
			let bytes = 0;
			let requestStats, usageParser;
			try {
			if (reauthenticationBlocked) return sendError(response, 401, 'Session authentication failed. Disconnect and reconnect after completing verification.');
			if (authentication) await waitForSignal(authentication, lifetime.signal);
			lifetime.signal.throwIfAborted();
			const chunks = []; let size = 0;
			for await (const chunk of request) { lifetime.signal.throwIfAborted(); size += chunk.length; if (size > 20 * 1024 * 1024) return sendError(response, 413, 'Request too large'); chunks.push(chunk); }
			lifetime.signal.throwIfAborted();
			const idleSeconds = vscode.workspace.getConfiguration('genai-login').get('idleTimeoutSeconds', 0);
			const idleMs = Number.isInteger(idleSeconds) && idleSeconds >= 0 && idleSeconds <= 86400 ? idleSeconds * 1000 : 0;
			lifetime.setIdleTimeout(idleMs);
			const options = { method: request.method, body: request.method === 'POST' ? Buffer.concat(chunks) : undefined, headers: { 'content-type': 'application/json', Accept: 'application/json' }, signal: lifetime.signal, fetch: upstreamFetch, dispatcher };
			if (request.method === 'POST') {
				requestStats = recordRequest(stats, options.body);
				history.start();
				dashboard?.refresh();
			}
			const forwardUpstream = async (routePath, requestOptions) => {
				let result = await session.request(ORIGIN + routePath, requestOptions);
				if (result.status !== 401) return result;
				await result.body?.cancel();
				trace('Proxy: authentication rejected with HTTP 401; attempting one login before forwarding');
				lifetime.setIdleTimeout(0);
				try { await waitForSignal(authenticate(true), lifetime.signal); } catch (error) {
					if (lifetime.signal.aborted) throw error;
					sendError(response, 401, 'Automatic login failed; disconnect and reconnect after checking credentials or verification.');
					return undefined;
				}
				lifetime.signal.throwIfAborted();
				lifetime.setIdleTimeout(idleMs);
				return session.request(ORIGIN + routePath, requestOptions);
			};
			if (route === '/api/v1/chat/completions') {
				let requestPayload;
				try { requestPayload = JSON.parse(options.body.toString('utf8')); } catch { requestPayload = undefined; }
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
						response.writeHead(imageResult.status, { 'content-type': imageResult.headers.get('content-type') || 'application/json' });
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
						response.writeHead(200, { 'content-type': 'text/event-stream' });
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
					response.writeHead(200, { 'content-type': 'application/json' });
					trace(`Proxy completed: status=200 elapsedMs=${Date.now() - startedAt} bytes=${body.length} image=chat`);
					return response.end(body);
				}
			}
			const result = await forwardUpstream(route, options);
			if (!result) return;
			lifetime.touch();
			void persist();
			const contentType = result.headers.get('content-type') || 'application/json';
			const sessionAccepted = result.ok && /application\/json|text\/event-stream/i.test(contentType);
			if (sessionAccepted) noteActivity();
			if (isCurrentConnection() && !authentication && !reauthenticationBlocked) status(`Connected :${stats.port}`);
			if (route === '/api/v1/images/generations' && result.ok) {
				let payload;
				const platformBody = await readImageResponseBody(result, lifetime, 1024 * 1024);
				try { payload = JSON.parse(platformBody.toString('utf8')); } catch { payload = undefined; }
				const data = await convertImageResponse(payload, (url, limit) => downloadPlatformImage(url, lifetime, limit));
				if (!data.length) return sendError(response, 502, 'Image generation did not return a downloadable image');
				const body = Buffer.from(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }));
				response.writeHead(200, { 'content-type': 'application/json' });
				trace(`Proxy completed: status=200 elapsedMs=${Date.now() - startedAt} bytes=${body.length} images=${data.length}`);
				return response.end(body);
			}
			response.writeHead(result.status, { 'content-type': contentType });
			if (!result.body) { settleRequest(requestStats); return response.end(); }
			usageParser = createUsageParser(contentType, requestStats);
			await forwardBody(result.body, response, lifetime, chunk => {
				bytes += chunk.length;
				usageParser.consume(chunk);
				if (sessionAccepted && Date.now() - keepaliveSchedule.snapshot().lastActivityAt >= 15000) noteActivity(false);
			}, result.status === 200 && contentType.toLowerCase().includes('text/event-stream'));
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
		server = http.createServer((request, response) => { handle(request, response).catch(() => {
			if (response.destroyed) return;
			if (active === controller && !controller.signal.aborted) status('Network error; retry request');
			if (!response.headersSent) sendError(response, 502, 'Upstream request failed. Retry when network is available.'); else response.destroy();
		}); });
			status('Connecting');
			await new Promise((resolve, reject) => { server.once('error', reject); server.listen(stats.port, '127.0.0.1', resolve); });
			await authenticate();
			startKeepalive();
		} catch (error) {
			if (controller.signal.aborted) return;
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
	const actions = { connect, diagnose, credentials, models, port, disconnect: async () => { if (await requireOwner()) stop(); }, clear: async () => {
		if (!await requireOwner()) return;
		const owner = active;
		const answer = await vscode.window.showWarningMessage('清除保存的账号和 Cookie？', { modal: true, detail: '当前连接将断开，账号和 Cookie 将删除。历史用量保留；此操作不会撤销服务器端会话。' }, '清除凭据');
		if (answer !== '清除凭据' || !await requireOwner() || active !== owner) return;
		stop(); await sessionPersistence?.flush(); await context.secrets.delete('credentials'); await context.secrets.delete('session');
	} };
	const reportError = async error => {
		if (error?.name === 'AbortError') return;
		const message = error?.code === 'EADDRINUSE' ? `端口 ${stats.port} 已占用。请关闭其他桥接，或设置另一个端口后重载。` :
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
}
function deactivate() { stopActive?.(); }
module.exports = { activate, deactivate };
