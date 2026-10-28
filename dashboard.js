const crypto = require('node:crypto');
const { version } = require('./package.json');

function dashboardHtml(initialState = null) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const initialJson = JSON.stringify(initialState).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>GENAI Login</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
        :root {
            color-scheme: light dark;
            --bg: var(--vscode-sideBar-background, #10151c);
            --panel: var(--vscode-editorWidget-background, #1a222c);
            --panel-strong: var(--vscode-sideBarSectionHeader-background, #202a35);
            --text: var(--vscode-sideBar-foreground, #e8eef5);
            --muted: var(--vscode-descriptionForeground, #8c99a8);
            --border: var(--vscode-widget-border, rgba(150, 170, 190, 0.2));
            --green: #43d392;
            --blue: #6ba9ff;
            --amber: #f3bd69;
            --red: #f27a7a;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-width: 220px;
            color: var(--text);
            background: linear-gradient(160deg, var(--bg) 0%, var(--panel) 100%);
            font-family: "Aptos", "Segoe UI", sans-serif;
            font-size: 12px;
        }
        button { font: inherit; color: inherit; }
        .shell { padding: 14px 12px 16px; }
        .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
        .brand-copy { min-width: 0; flex: 1; }
        .brand-mark {
            display: grid;
            width: 32px;
            height: 32px;
            place-items: center;
            border: 1px solid rgba(67, 211, 146, 0.5);
            border-radius: 9px;
            color: #0d1c18;
            background: var(--green);
            font-size: 17px;
            font-weight: 800;
        }
        .eyebrow { color: var(--green); font-size: 9px; font-weight: 800; letter-spacing: 1.1px; }
        h1 { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin: 2px 0 0; font-size: 17px; letter-spacing: 0; }
        .version-tag { margin-left: 7px; padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); background: rgba(255, 255, 255, 0.05); font-size: 10px; font-weight: 650; vertical-align: 2px; }
        .icon-button {
            width: 29px;
            height: 29px;
            margin-left: auto;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: transparent;
            cursor: pointer;
            font-size: 17px;
            line-height: 1;
        }
        .icon-button:hover, .icon-button:focus-visible { border-color: var(--blue); background: rgba(107, 169, 255, 0.12); outline: none; }
        .status-banner {
            display: flex;
            align-items: center;
            gap: 9px;
            min-height: 58px;
            padding: 10px 11px;
            border: 1px solid var(--border);
            border-radius: 11px;
            background: rgba(255, 255, 255, 0.035);
        }
        .status-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 4px rgba(140, 153, 168, 0.12); }
        .status-dot.connected { background: var(--green); box-shadow: 0 0 0 4px rgba(67, 211, 146, 0.14); }
        .status-dot.busy { background: var(--amber); box-shadow: 0 0 0 4px rgba(243, 189, 105, 0.14); }
        .status-dot.error { background: var(--red); box-shadow: 0 0 0 4px rgba(242, 122, 122, 0.14); }
        .status-dot.warning { background: var(--amber); box-shadow: 0 0 0 4px rgba(243, 189, 105, 0.14); }
        .status-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .status-copy strong { overflow-wrap: anywhere; font-size: 13px; }
        .status-copy small { color: var(--muted); overflow-wrap: anywhere; line-height: 1.4; }
        .session-warning { color: var(--amber); line-height: 1.5; margin: 8px 2px 0; }
        .port-badge { margin-left: auto; padding: 4px 7px; border: 1px solid rgba(107, 169, 255, 0.35); border-radius: 6px; color: var(--blue); background: rgba(107, 169, 255, 0.1); font-size: 10px; white-space: nowrap; }
        .section-label { display: flex; align-items: center; justify-content: space-between; margin: 16px 2px 7px; color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: 1px; }
        .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .metric {
            position: relative;
            min-width: 0;
            min-height: 78px;
            padding: 10px;
            border: 1px solid var(--border);
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.045);
            cursor: default;
            outline: none;
            transition: border-color 120ms ease, background 120ms ease;
        }
        .metric:hover, .metric:focus-visible { z-index: 10; border-color: rgba(107, 169, 255, 0.6); background: rgba(107, 169, 255, 0.09); }
        .metric-label { color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: 0.7px; }
        .metric-value { display: block; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 19px; font-weight: 750; }
        .metric-detail { display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 10px; }
        #token-detail { white-space: pre-line; overflow-wrap: anywhere; overflow: visible; }
        .usage-breakdown { margin-top: 10px; overflow-wrap: anywhere; white-space: normal; }
        .usage-row { padding: 8px 0; border-top: 1px solid var(--border); }
        .usage-row strong, .usage-row small { display: block; }
        .usage-row small { margin-top: 4px; color: var(--muted); line-height: 1.5; }
        .usage-note { color: var(--muted); white-space: normal; line-height: 1.5; }
        .usage-hover:hover, .usage-hover:focus-within { z-index: 10; }
        .usage-hover > .hover-card { top: 100%; pointer-events: auto; max-height: 320px; overflow-y: auto; }
        .usage-hover:hover > .hover-card, .usage-hover:focus-within > .hover-card { display: block; }
        .history-bar {
            position: relative;
            display: flex;
            align-items: center;
            gap: 7px;
            min-width: 0;
            margin-top: 15px;
            padding: 7px 9px;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.04);
            color: var(--muted);
            font-size: 10px;
            white-space: nowrap;
        }
        .history-bar strong { flex: 0 0 auto; color: var(--amber); font-size: 11px; }
        .history-bar .history-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .hover-card {
            display: none;
            white-space: normal;
            position: absolute;
            top: calc(100% + 6px);
            left: 0;
            right: 0;
            z-index: 1;
            padding: 9px 10px;
            border: 1px solid rgba(107, 169, 255, 0.45);
            border-radius: 8px;
            color: var(--text);
            background: #202020;
            background: linear-gradient(var(--vscode-editor-background, #202020), var(--vscode-editor-background, #202020)), #202020;
            box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
            opacity: 1;
            pointer-events: none;
            overflow-wrap: anywhere;
            transition: opacity 120ms ease, transform 120ms ease;
        }
        .metric:hover .hover-card, .metric:focus-visible .hover-card { display: block; }
        .model-list { display: flex; flex-direction: column; gap: 5px; }
        .model-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            padding: 8px 9px;
            border-left: 2px solid var(--blue);
            border-radius: 0 7px 7px 0;
            background: rgba(255, 255, 255, 0.04);
        }
        .model-name { min-width: 0; flex: 1; overflow-wrap: anywhere; color: var(--text); }
        .model-count { flex: 0 0 auto; color: var(--amber); font-size: 10px; }
        .empty-models { padding: 12px 8px; border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); text-align: center; }
        .action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
        .action-tile {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            min-height: 48px;
            padding: 8px 9px;
            border: 1px solid var(--border);
            border-radius: 9px;
            background: rgba(255, 255, 255, 0.04);
            cursor: pointer;
            text-align: left;
            transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
        }
        .action-tile:hover, .action-tile:focus-visible { border-color: var(--blue); background: rgba(107, 169, 255, 0.1); outline: none; transform: translateY(-1px); }
        .action-tile:disabled { opacity: 0.5; cursor: default; transform: none; background: rgba(255, 255, 255, 0.04); border-color: var(--border); }
        .action-tile.primary { border-color: rgba(67, 211, 146, 0.45); }
        .action-tile.primary:hover, .action-tile.primary:focus-visible { border-color: var(--green); background: rgba(67, 211, 146, 0.1); }
        .action-tile.danger:hover, .action-tile.danger:focus-visible { border-color: var(--red); background: rgba(242, 122, 122, 0.1); }
        .action-icon { display: grid; width: 24px; height: 24px; flex: 0 0 auto; place-items: center; border-radius: 6px; color: var(--blue); background: rgba(107, 169, 255, 0.13); font-size: 16px; font-weight: 700; }
        .primary .action-icon { color: var(--green); background: rgba(67, 211, 146, 0.13); }
        .danger .action-icon { color: var(--red); background: rgba(242, 122, 122, 0.13); }
        .action-copy { min-width: 0; }
        .action-copy strong, .action-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .action-copy strong { font-size: 11px; }
        .action-copy small { margin-top: 2px; color: var(--muted); font-size: 9px; }
        .footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 15px; color: var(--muted); font-size: 9px; }
        .footer button { padding: 0; border: 0; color: var(--blue); background: transparent; cursor: pointer; }
        .footer button:hover { color: var(--text); }
        @media (max-width: 270px) {
            .metric-grid, .action-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <main class="shell">
        <header class="brand">
            <div class="brand-mark">G</div>
            <div class="brand-copy">
                <h1>GENAI Login<span class="version-tag" title="GENAI Login v${version}">v${version}</span></h1>
            </div>
            <button class="icon-button" data-command="refresh" title="刷新状态" aria-label="刷新状态">↻</button>
        </header>
        <section class="status-banner" aria-live="polite">
            <span id="status-dot" class="status-dot"></span>
            <div class="status-copy">
                <strong id="status-text">未连接</strong>
                <small id="keepalive-text">等待连接</small>
            </div>
            <span id="port-badge" class="port-badge">:58379</span>
        </section>
        <p id="session-warning" class="session-warning" role="status" hidden></p>
        <div class="section-label"><span>实时概览</span><span id="sync-text">尚未同步</span></div>
        <section class="metric-grid">
            <div class="metric" tabindex="0">
                <span class="metric-label">UPTIME / 时长</span>
                <strong id="uptime-value" class="metric-value">--</strong>
                <small class="metric-detail">从本次连接开始</small>
                <span class="hover-card">连接保持期间持续更新，不包含断开前的历史时长。</span>
            </div>
            <div class="metric usage-hover" tabindex="0">
                <span class="metric-label">TOKENS / 总用量</span>
                <strong id="token-value" class="metric-value">--</strong>
                <small id="token-detail" class="metric-detail">等待上游 usage</small>
                <div class="hover-card" tabindex="0" role="region" aria-label="总用量明细">
                    <div id="token-breakdown" class="usage-breakdown"></div>
                </div>
            </div>
            <div class="metric" tabindex="0">
                <span class="metric-label">CACHE / 缓存命中率</span>
                <strong id="cache-value" class="metric-value">--</strong>
                <small id="cache-detail" class="metric-detail">等待缓存用量</small>
                <span class="hover-card">按输入 token 加权的缓存命中率。</span>
            </div>
            <div class="metric usage-hover" tabindex="0">
                <span class="metric-label">AI使用量 / 估算 USD</span>
                <strong id="cost-value" class="metric-value">--</strong>
                <small id="cost-detail" class="metric-detail">所有模型合计</small>
                <div id="cost-breakdown" class="hover-card" tabindex="0" role="region" aria-label="各模型费用"></div>
            </div>
        </section>
        <div class="section-label"><span>使用的模型</span><span id="model-count">0</span></div>
        <section id="model-list" class="model-list"><div class="empty-models">还没有聊天请求</div></section>
        <section class="action-grid" aria-label="连接操作">
            <button class="action-tile" data-command="port" title="设置本地反代端口" aria-label="设置本地反代端口">
                <span class="action-icon" aria-hidden="true">⚙</span><span class="action-copy"><strong>设置端口</strong><small>本地监听端口</small></span>
            </button>
            <button class="action-tile" data-command="models" title="添加或删除 Copilot 模型">
                <span class="action-icon">±</span><span class="action-copy"><strong>Copilot 模型</strong><small>添加 / 删除</small></span>
            </button>
            <button class="action-tile" data-command="mcp" title="添加 Qwen Image 2.1 绘画 MCP 服务器" aria-label="添加绘画 MCP 服务器">
                <span class="action-icon" aria-hidden="true">M</span><span class="action-copy"><strong>添加绘画 MCP</strong><small>Qwen Image 2.1</small></span>
            </button>
            <button class="action-tile primary" data-command="connect">
                <span class="action-icon">+</span><span class="action-copy"><strong id="connect-label">连接 GENAI</strong><small>登录并启动桥接</small></span>
            </button>
            <button class="action-tile" data-command="credentials">
                <span class="action-icon">K</span><span class="action-copy"><strong>账号设置</strong><small>更新安全凭据</small></span>
            </button>
            <button class="action-tile" data-command="disconnect">
                <span class="action-icon">−</span><span class="action-copy"><strong>断开连接</strong><small>停止端口与保活</small></span>
            </button>
            <button class="action-tile danger" data-command="clear">
                <span class="action-icon">×</span><span class="action-copy"><strong>清除数据</strong><small>删除账号与 Cookie</small></span>
            </button>
            <button class="action-tile" data-command="diagnose" title="在可见 Edge 窗口中诊断登录">
                <span class="action-icon" aria-hidden="true">E</span><span class="action-copy"><strong>可见诊断</strong><small>Edge</small></span>
            </button>
        </section>
        <div class="history-bar usage-hover" tabindex="0">
            <strong id="history-tokens">--</strong>
            <span id="history-detail" class="history-meta">正在读取历史统计</span>
            <div class="hover-card" tabindex="0" role="region" aria-label="历史用量明细">
                <div id="history-breakdown" class="usage-breakdown"></div>
            </div>
        </div>
        <footer class="footer"><span id="last-check">保活：尚未检查</span><button data-command="refresh">刷新数据</button></footer>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let snapshot;
        const byId = id => document.getElementById(id);
        const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
        const numberFormatter = new Intl.NumberFormat('zh-CN');
        const clockFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const formatNumber = value => numberFormatter.format(number(value));
        const formatTokens = value => value === null || value === undefined ? '--' : formatNumber(value);
        const formatDuration = milliseconds => {
            const seconds = Math.max(0, Math.floor(milliseconds / 1000));
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const rest = seconds % 60;
            return hours ? hours + 'h ' + minutes + 'm' : minutes ? minutes + 'm ' + rest + 's' : rest + 's';
        };
        const formatClock = timestamp => timestamp ? clockFormatter.format(timestamp) : '--';
        const formatShort = value => {
            if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
            const tokens = Number(value);
            if (tokens >= 1e8) return (tokens / 1e8).toFixed(2) + ' 亿';
            if (tokens >= 1e4) return (tokens / 1e4).toFixed(1) + ' 万';
            return formatNumber(tokens);
        };
        const connectionState = data => data.connection || (String(data.status).startsWith('Connected') ? 'connected' :
            String(data.status).startsWith('Authenticating') ? 'authenticating' : String(data.status).startsWith('Connecting') ? 'connecting' :
            String(data.status).startsWith('Disconnected') ? 'disconnected' : 'error');
        const connected = data => Boolean(data.connectedAt && connectionState(data) === 'connected');
        let uptimeTimer;
        const syncUptimeTimer = () => {
            if (!snapshot || !connected(snapshot) || document.hidden) {
                clearInterval(uptimeTimer);
                uptimeTimer = undefined;
            } else if (uptimeTimer === undefined) {
                uptimeTimer = setInterval(() => {
                    const value = formatDuration(Date.now() - snapshot.connectedAt);
                    if (byId('uptime-value').textContent !== value) byId('uptime-value').textContent = value;
                }, 1000);
            }
        };
        const renderedLists = new Map();
        const listChanged = (id, rows) => {
            const value = JSON.stringify(rows);
            if (renderedLists.get(id) === value) return false;
            renderedLists.set(id, value);
            return true;
        };
        const money = value => Number(value).toFixed(6);
        const costText = usage => number(usage.timedReports) === number(usage.pricedReports)
            ? money(usage.costMin) : money(usage.costMin) + ' ~ ' + money(usage.costMax);
        const cacheRate = usage => usage.cacheInputTokens > 0 ? (100 * usage.cachedTokens / usage.cacheInputTokens).toFixed(1) + '%' : '--';
        function renderUsage(id, rows) {
            if (!listChanged(id, rows)) return;
            const list = byId(id);
            list.replaceChildren();
            for (const usage of rows) {
                const row = document.createElement('div');
                row.className = 'usage-row';
                const title = document.createElement('strong');
                const tokens = number(usage.tokensIn) + number(usage.tokensOut);
                title.textContent = usage.name + ' · ' + formatNumber(tokens) + ' tok';
                const detail = document.createElement('small');
                detail.textContent = 'IN ' + (usage.inputUsageReports ? formatNumber(usage.tokensIn) : '--') + ' / OUT ' + (usage.outputUsageReports ? formatNumber(usage.tokensOut) : '--') +
                    ' · 缓存命中 ' + cacheRate(usage);
                const cost = document.createElement('small');
                cost.textContent = usage.pricedReports ? '估算 USD ' + costText(usage) : '未定价';
                row.append(title, detail, cost);
                list.append(row);
            }
            if (!rows.length) {
                const note = document.createElement('p');
                note.className = 'usage-note';
                note.textContent = '暂无用量';
                list.append(note);
            }
        }
        function renderModels(models) {
            if (!listChanged('model-list', models)) return;
            const list = byId('model-list');
            list.replaceChildren();
            byId('model-count').textContent = String(models.length);
            if (!models.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-models';
                empty.textContent = '还没有聊天请求';
                list.append(empty);
                return;
            }
            for (const model of models) {
                const row = document.createElement('div');
                row.className = 'model-row';
                const name = document.createElement('span');
                name.className = 'model-name';
                name.textContent = model.name;
                const count = document.createElement('span');
                count.className = 'model-count';
                count.textContent = formatNumber(model.requests) + ' 次';
                row.append(name, count);
                list.append(row);
            }
        }
        function render(data) {
            snapshot = data;
            const isConnected = connected(data);
            const mode = connectionState(data);
            const shared = Boolean(data.shared || String(data.status).includes('(shared window)'));
            const busy = mode === 'authenticating' || mode === 'connecting';
            const active = data.active ?? (isConnected || busy || Boolean(data.connectedAt));
            const recoverable = !busy && ['error', 'retrying', 'needs-login'].includes(data.keepalive?.state);
            const pending = Array.isArray(data.pendingActions) ? data.pendingActions : [];
            const exclusivePending = pending.some(command => ['connect', 'diagnose', 'credentials', 'clear'].includes(command));
            for (const button of document.querySelectorAll('[data-command]')) {
                const command = button.dataset.command;
                button.disabled = pending.includes(command) ||
                    (command === 'connect' && (active && !recoverable || busy || shared || exclusivePending)) ||
                    (['diagnose', 'credentials'].includes(command) && (active || shared || exclusivePending)) ||
                    (command === 'clear' && (shared || exclusivePending)) ||
                    (command === 'disconnect' && (!(active || data.listening || pending.includes('connect')) || shared));
            }
            byId('connect-label').textContent = active && recoverable ? '重新连接' : '连接 GENAI';
            const warning = data.sessionPersistence === 'error' || ['error', 'retrying', 'needs-login'].includes(data.keepalive?.state) ||
                (data.keepalive?.expiresAt && data.keepalive.expiresAt - Date.now() <= 60000);
            const dot = byId('status-dot');
            dot.className = 'status-dot ' + (busy ? 'busy' : mode === 'error' ? 'error' : warning ? 'warning' : isConnected ? 'connected' : '');
            const label = mode === 'disconnected' && data.listening ? '待命' : { connected: '已连接', disconnected: '未连接', connecting: '正在连接', authenticating: '正在登录', error: '请求暂时失败' }[mode] || '未连接';
            byId('status-text').textContent = label + (shared ? ' · 其他窗口' : '');
            byId('port-badge').textContent = (data.listening ?? isConnected) ? ':' + data.port : '未监听';
            byId('session-warning').hidden = data.sessionPersistence !== 'error';
            byId('session-warning').textContent = data.sessionPersistence === 'error' ? 'Cookie 保存失败，当前连接可继续；重载后可能需要重新登录。' : '';
            const hasUsage = number(data.usageReports) > 0;
            byId('token-value').textContent = hasUsage ? formatTokens(number(data.tokensIn) + number(data.tokensOut)) : '--';
            const inputKnown = number(data.inputUsageReports ?? data.usageReports) > 0;
            const outputKnown = number(data.outputUsageReports ?? data.usageReports) > 0;
            byId('token-detail').textContent = 'IN 输入：' + (inputKnown ? formatTokens(data.tokensIn) : '--') + '\\nOUT 输出：' + (outputKnown ? formatTokens(data.tokensOut) : '--');
            const usageRows = Array.isArray(data.modelUsage) ? data.modelUsage : [];
            renderUsage('token-breakdown', usageRows, number(data.tokensIn) + number(data.tokensOut));
            const cache = usageRows.reduce((total, usage) => ({ cachedTokens: total.cachedTokens + number(usage.cachedTokens), cacheInputTokens: total.cacheInputTokens + number(usage.cacheInputTokens), cacheReports: total.cacheReports + number(usage.cacheReports) }), { cachedTokens: 0, cacheInputTokens: 0, cacheReports: 0 });
            byId('cache-value').textContent = cacheRate(cache);
            byId('cache-detail').textContent = '缓存报告 ' + cache.cacheReports + '/' + number(data.requests) + ' 次';
            const costs = usageRows.reduce((total, usage) => ({ costMin: total.costMin + number(usage.costMin), costMax: total.costMax + number(usage.costMax), pricedReports: total.pricedReports + number(usage.pricedReports), timedReports: total.timedReports + number(usage.timedReports) }), { costMin: 0, costMax: 0, pricedReports: 0, timedReports: 0 });
            byId('cost-value').textContent = costs.pricedReports ? costText(costs) : '--';
            byId('cost-detail').textContent = usageRows.some(usage => !usage.pricedReports) ? '已计价模型合计' : '所有模型合计';
            const costList = byId('cost-breakdown');
            if (listChanged('cost-breakdown', usageRows)) {
                costList.replaceChildren();
                for (const usage of usageRows) {
                    const row = document.createElement('div');
                    row.className = 'usage-row';
                    const title = document.createElement('strong');
                    title.textContent = usage.name;
                    const value = document.createElement('small');
                    value.textContent = usage.pricedReports ? 'USD ' + costText(usage) : '未定价';
                    row.append(title, value);
                    costList.append(row);
                }
                if (!usageRows.length) costList.textContent = '暂无用量';
            }
            const keepalive = data.keepalive || {};
            const expiring = keepalive.expiresAt && keepalive.expiresAt - Date.now() <= 60000;
            const phases = { 'checking-session': '正在验证保存的会话', 'opening-browser': '正在启动 Edge', 'webui-entry': '正在打开 GENAI 登录页', credentials: '正在提交 UMPASS 登录',
                mfa: '等待手机 MFA 确认', umpass: '等待 UMPASS 验证', redirect: '等待身份认证跳转', callback: '正在验证 GENAI 会话' };
            const health = mode === 'authenticating' ? phases[data.loginPhase] || '正在验证登录' :
                keepalive.state === 'needs-login' ? '验证未完成，请重新连接' :
                keepalive.state === 'retrying' ? '重登暂时失败' + (keepalive.nextCheckAt ? '，' + formatClock(keepalive.nextCheckAt) + ' 自动重试' : '，等待自动重试') :
                keepalive.state === 'error' && keepalive.reason === 'session-check-timeout' ? '会话检查超时，连接可重试' :
                keepalive.state === 'error' ? '保活暂时失败' + (keepalive.nextCheckAt ? '，' + formatClock(keepalive.nextCheckAt) + ' 重试' : '，等待重试') :
                keepalive.state === 'checking' ? '正在检查会话' : keepalive.state === 'reauthenticating' ? '认证已失效，正在重认证' :
                expiring ? '会话即将或已经到期，服务端可能要求重新登录' :
                keepalive.state === 'healthy' ? '会话有效' : isConnected ? '等待首次检查' : '等待连接';
            byId('keepalive-text').textContent = (shared ? '只读 · ' : '') + health;
            byId('last-check').textContent = keepalive.nextCheckAt ? '下次检查 ' + formatClock(keepalive.nextCheckAt) : '保活：尚未安排';
            byId('last-check').title = '上次检查 ' + formatClock(keepalive.lastCheckAt) +
                (keepalive.expiresAt ? ' · 会话到期 ' + formatClock(keepalive.expiresAt) : ' · 会话到期时间未知');
            byId('sync-text').textContent = '同步 ' + formatClock(Date.now());
            byId('uptime-value').textContent = isConnected ? formatDuration(Date.now() - data.connectedAt) : '--';
            renderModels(Array.isArray(data.models) ? data.models : []);
            const history = data.history;
            renderUsage('history-breakdown', Array.isArray(history?.modelUsage) ? history.modelUsage : [], number(history?.tokensIn) + number(history?.tokensOut));
            byId('history-tokens').textContent = history && (history.inputUsageReports || history.outputUsageReports) ? formatTokens(number(history.tokensIn) + number(history.tokensOut)) + ' tok' : '--';
            byId('history-detail').textContent = history ? history.inputUsageReports + history.outputUsageReports
                ? '调用 ' + formatNumber(history.requests) + ' 次 · IN ' + (formatShort(history.tokensIn) ?? '--') + ' · OUT ' + (formatShort(history.tokensOut) ?? '--')
                : '调用 ' + formatNumber(history.requests) + ' 次 · 等待 usage' : '未连接，无历史统计';
            syncUptimeTimer();
        }
        document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => {
            if (!button.disabled) vscode.postMessage({ command: button.dataset.command });
        }));
        window.addEventListener('message', event => { if (event.data && event.data.type === 'state') render(event.data.data); });
        const initialState = ${initialJson};
        if (initialState) render(initialState);
        document.addEventListener('visibilitychange', syncUptimeTimer);
        vscode.postMessage({ command: 'ready' });
        requestAnimationFrame(() => requestAnimationFrame(() => vscode.postMessage({ command: 'painted' })));
    </script>
</body>
</html>`;
}

module.exports = { dashboardHtml };