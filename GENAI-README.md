# GENAI Login

User guide for the GENAI Login connection dashboard. For installation, client configuration, development, and licensing, see the [project README](README.md).

GENAI Login is an independent community extension, not an official University of Macau product. An authorized UMPASS account is required.

## Install and Update

Install [GENAI Login](https://marketplace.visualstudio.com/items?itemName=Petalzu.genai-login) from the official Visual Studio Marketplace. In VS Code's **Extensions** view, search for `@id:Petalzu.genai-login` and select **Install**. Enable **Auto Update** in the extension's management menu to receive subsequent versions in VS Code.

Version 0.0.16 is the final GitHub Release. Future extension updates will be distributed through the Marketplace; source code and issue tracking remain on GitHub.

## Connect

1. Open **GENAI Login** in the activity bar.
2. Select **账号设置**, or run **GENAI Login: Save account and password**, and enter your UMPASS credentials.
3. Send a request through a configured Copilot GENAI chat model or MCP image tool. The extension connects in the background; manual connection is not required.
4. Complete any required MFA and wait for the response. If credentials are missing, the first request prompts for them in VS Code.

Automatic connection and ordinary manual Connect use the same temporary headless Edge flow. Both open the official GENAI home page in a short-lived authentication helper, import saved cookies, and verify the session through the browser network. A valid saved session avoids another UMPASS/MFA login. Node network checks no longer prevent the browser from starting. The helper and Edge close after verification, releasing browser automation dependencies instead of retaining them in VS Code. Only visible diagnostics open a visible browser. MFA approval remains your responsibility.

The browser session check has a 30-second deadline, separate from the three-minute login/MFA deadline. Temporary gateway or connection errors receive at most two bounded retries. The original prompt waits for the shared login and is forwarded after verification; another prompt is not needed when login succeeds. If a temporary pre-submission failure remains, the request receives HTTP 503 and Retry-After; subsequent requests do not start another login during the cooldown, which grows from 30 seconds to five minutes and respects longer server Retry-After values. Explicit Connect can retry immediately. Incomplete MFA or a failure after credential submission stops repeated automatic logins until an explicit reconnect. Network failures do not require clearing saved credentials, and persistent service outages cannot be overcome by extending the login timeout.

The dashboard initially shows **待命**: the local port is listening, but no login, Edge instance or health checks have started. Selecting **连接 GENAI** or running **GENAI Login: Login and connect** remains available to log in before making a request. Status queries do not trigger authentication.

When Duo displays a recognized device-confirmation prompt, the extension selects **Yes, this is my device**. This does not approve MFA or guarantee that future temporary browser sessions will be remembered. Use the extension only on a trusted personal device.

## Manage the Connection

- **Disconnect** stops the bridge listener and session checks without deleting saved credentials or history. Automatic connection stays off until you explicitly connect again or reload the window.
- **Clear saved credentials and session** requires confirmation, disconnects the bridge, and removes saved credentials and cookies. Usage history remains; the server-side session is not revoked.
- **Manage Copilot models** adds or removes presets in the current Profile. Addition and deletion are separate operations; unchecking a model during addition does not delete it. Configuration changes require confirmation and create a backup.

Only the window that owns the bridge can disconnect it or change credentials. Other windows display read-only connection status. Use the same port across participating windows.

## Image Generation with MCP

1. Keep a desktop VS Code window with GENAI Login enabled open. Saving credentials once is recommended; there is no need to connect manually before using the tool.
2. Select **添加绘画 MCP** in the dashboard, or run **GENAI Login: Add Qwen Image 2.1 drawing MCP server**. Repeating the command does not create duplicate servers.
3. In Copilot **Agent** mode, select a tool-capable chat model and enable `generate_image` from **GENAI / Qwen Image 2.1** in the tools picker. Accept any VS Code server trust or tool-call approval prompts.
4. Ask Copilot to draw an image. The tool accepts a text `prompt`, optional `size` such as `1024x1024`, and `n` from 1 to 6. It returns image previews and the paths of the original files saved on the local VS Code machine.

The server is embedded in GENAI Login and registered through VS Code's native MCP API. No Node.js/npm, ImageForge installation, API-key prompt or manual `mcp.json` edit is required. The command only enables `genai-login.imageMcp.enabled` in user settings; existing MCP servers are unchanged. Disable this setting to stop advertising the drawing server.

The tool requests the local `/v1/images/generations` endpoint with the fixed model `qwen-image-2.1`. The platform's configured image engine determines the actual model used. Files are saved in the extension's local data directory under `generated-images`; they remain until manually deleted. Remote-SSH agents receive previews, but returned local paths are not paths on the remote host. Copy files explicitly when a remote workspace needs them.

The first request automatically reuses the saved session or starts a background login. Concurrent chat and image requests share the login. Allow enough time in the MCP client's request timeout to complete MFA; cancelling a request does not cancel other clients' login. The extension cannot receive requests if it is disabled or all desktop VS Code windows are closed.

Image models are not offered by **Manage Copilot models**. They do not need to be registered as chat models to be used through MCP. An OpenAI Images-compatible client can use the same endpoint directly.

Existing external tools such as ImageForge can still use `provider: openai`, `base_url: http://127.0.0.1:58379/v1`, `api_key: local-browser-session`, and `model: qwen-image-2.1`. Their MCP process must run on the bridge machine. Use the configured port if it differs from the default.

The image endpoint returns inline `data[].b64_json`, with at most six files and 20 MiB of image data per request. Image requests are counted without invented token usage.

## Session Health

The dashboard displays session health, the next scheduled check, and known expiry information. Successful request activity reduces redundant checks. During healthy operation, checks run after two idle minutes or at least once every five minutes. Temporary failures use backoff and respect server rate limits.

Health checks cannot extend a fixed token lifetime. Expired authentication triggers one shared login that may require MFA. Temporary failures before credential submission allow at most two recovery retries with backoff and Retry-After; new requests receive HTTP 503 during the cooldown instead of starting more logins. Rejected credentials, incomplete MFA, failures after credential submission, and exhausted retries stop automatic login attempts. Select **重新连接** to retry without disconnecting active streams or resetting usage. Already-started streams are not automatically replayed.

If three consecutive session checks fail because of gateway or connection errors, the extension may try the same browser entry used by manual reconnect once per outage. A successful health check or new authenticated request resets this allowance. Forbidden responses, rate limits and responses carrying Retry-After do not trigger this fallback; persistent platform outages still require the service to recover.

Hiding the dashboard does not stop the bridge or session checks. Closing or reloading the owner window ends active requests; after a reload, the window returns to the idle-listener state. Finish active requests before upgrading or reloading, and reload every participating window to use the installed version.

## Troubleshooting

### Login Stalls

Disconnect, then run **GENAI Login: Diagnose login in visible Edge** or select **可见诊断**. Inspect the visible browser for verification, consent, or error pages. Diagnostic Edge remains open until disconnect; the login deadline is three minutes.

Open **View > Output** and select **GENAI Login** for sanitized authentication stages and transport error codes. Do not share authentication callback URLs, passwords, cookies, or tokens.

### Port Is Occupied

Check whether another VS Code window already owns the connection. Manage it there, or change **genai-login.port**, reload participating windows, and update client URLs. Only one bridge can listen on a given port.

### Upstream or Session Errors

Temporary service errors do not necessarily indicate expired credentials. Allow the scheduled health retry, or retry the client request after service recovers. If a response was partially delivered, review its content before retrying.

Browser login starts at the GENAI home page and selects its UMPASS sign-in button. Temporary gateway failures are retried at most twice before credentials are submitted. An explicit **连接 GENAI** can also reopen the home page if the saved-session check repeatedly fails. An existing connection permits one bounded browser recovery after three consecutive unavailable checks, subject to the session-health limits above. A persistent `no healthy upstream` page is a platform gateway failure, not a password error or evidence of a new login URL.

A cookie-storage warning means the current session may continue, but reconnecting after a reload can require a new login. Failed initial verification blocks automatic login retries; use **连接 GENAI** after checking credentials or MFA. For a failed existing connection, select **重新连接** directly; disconnecting first is no longer required. The dashboard distinguishes a temporary health failure, a scheduled login retry and a verification failure requiring your attention.

### Busy Bridge or Queue Timeout

The bridge defaults to 32 active requests, 64 waiting requests and a 128 MiB request-body reservation budget. Waiting requests do not read their full bodies until admitted. When the queue is full or its 60-second deadline expires, the client receives HTTP `503` with `Retry-After`; this is local overload, not proof that your login expired. Cancelling a request removes it from the queue without cancelling shared MFA or other streams.

The settings `genai-login.maxConcurrentRequests`, `genai-login.maxQueuedRequests`, `genai-login.maxBufferedRequestMiB` and `genai-login.queueTimeoutSeconds` control these limits. Reload participating windows after changing them. The body budget is not a total memory cap, and larger limits cannot bypass the platform's quotas. Upstream retry hints are forwarded so clients can respect server-requested delays; partially delivered responses and image requests are not automatically replayed.

### Remote Clients Cannot Connect

The bridge listens on the VS Code client machine. A process running on a Remote-SSH host cannot reach it through that host's `127.0.0.1`. Use a client on the local machine; do not expose the bridge to untrusted networks.

## Usage and Cost Estimates

Token statistics use usage data reported by GENAI. Requests without usage are counted without an invented token estimate. Disconnecting or clearing credentials does not reset history.

Cost estimates are reference values, not GENAI charges. Model rates and cache assumptions are documented in [PRICING.md](PRICING.md).