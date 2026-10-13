# GENAI Login

## Version 0.0.14

## Install

Download the `.vsix` asset from [GitHub Releases](https://github.com/Petalzu/GenaiHelper/releases/latest), then use VS Code **Extensions > ... > Install from VSIX...**. Alternatively run `code --install-extension genai-login-0.0.13.vsix --force`. Reload the window after active conversations finish. No Node.js or npm installation is needed for the packaged extension.

GENAI Login is a local VS Code extension for UMPASS authentication and an OpenAI-compatible bridge.

## Usage

Open GENAI in the activity bar. The connection dashboard provides square action tiles for account setup, connection, disconnect, and clearing saved data. It also shows the local port, connection uptime, bridge request count, model usage, keepalive state, and token usage reported by GENAI.

Edge must be installed. A saved valid cookie jar skips the browser login. Otherwise the extension starts temporary headless Microsoft Edge, fills the saved UMPASS credentials once, and waits for the normal MFA and redirect flow. After API verification, the Edge session remains available until Disconnect so the session can be kept alive. Disconnect, timeout, cancellation, authentication failure, window reload, and VS Code exit close it.

If phone approval succeeds but the connection stalls, disconnect first and use the dashboard's **可见诊断** action or run **GENAI: Diagnose login in visible Edge** from the Command Palette. This uses the same login flow in a visible temporary Edge window so additional verification, consent or error pages can be inspected. Login retains its 180-second deadline. Authentication diagnostics record hostnames, fixed route categories, navigation status/error codes and page structure flags, not URL parameters, form values, page text or cookies. Do not share callback URLs, authentication codes or cookies when reporting a failure.

Duo may ask whether to remember the device after phone approval. On the official Duo API host, when both exact device-confirmation choices are visible, the extension selects **Yes, this is my device** once, as the default for this personal device. The English choices and the verified Simplified Chinese equivalents are supported, including a link-style negative choice. It does not approve MFA or click other verification or consent controls. Other prompts require the visible diagnostic login. Edge still uses a temporary browser context, so choosing to remember the device does not guarantee that a new browser context after Disconnect or reload will skip MFA.

Credentials and cookies are stored in VS Code SecretStorage. Clear removes both stored values; it does not revoke the server-side session.

Endpoint: `http://127.0.0.1:58379/v1/chat/completions`. Compatibility key: `local-browser-session`. The bridge requires the fixed local Host, Bearer, and Fetch Metadata checks and refuses requests with an Origin header. The compatibility key is not a strong security boundary against other local programs, so do not expose the port beyond loopback.

Only one VS Code window owns port 58379. Other activated extension windows on the same machine synchronize the owner's connection status, uptime, request/token totals, model usage and keepalive state every two seconds through an authenticated local status endpoint. Status reads do not count as model requests and do not return cookies or credentials. Connecting in an observer window reuses the existing owner. Disconnect, account changes and clearing data must be performed in the owner window. Closing an observer does not stop the bridge; closing or reloading the owner does, and observers clear their shared state when the endpoint becomes unavailable. No automatic ownership transfer is performed. All participating windows must use this updated extension; older bridges without the status endpoint cannot be synchronized.

Observer polling runs only while the GENAI dashboard is visible. Opening or revealing it fetches fresh state immediately and then every two seconds; hiding or disposing it stops polling and cancels the pending status request. Activating the extension alone does not fetch shared state. Explicit connection/account commands still perform a one-off ownership check even when the dashboard is hidden. The owner's bridge and session keepalive continue independently of dashboard visibility.

The bridge retries one request after authentication expiry; streamed conversations are not automatically replayed. The 60-second keepalive is serialized so checks cannot overlap, and refreshed cookies are persisted.

Upstream idle timeout defaults to 0 (disabled), with no total generation deadline. Set `genai-login.idleTimeoutSeconds` in VS Code Settings to a positive number (up to 86400) to enable an idle timeout for new requests, reset by response headers and forwarded chunks. Model requests use a separate HTTP pool with header/body timeouts disabled. Client disconnection cancels the upstream request, and streaming respects client backpressure. Session health checks retain a separate 30-second timeout.

Use the port tile or `genai-login.port` in VS Code Settings to customize the loopback port (1024-65535, default 58379). Reload participating windows after current requests finish, and update client URLs to the new port. Listening, Host checks, dashboard details and visible-window synchronization use the configured port. Credentials remain in SecretStorage, not settings. Dashboard details float downwards with an opaque background without changing card dimensions.

The GENAI Login output records proxy duration, received byte count and sanitized transport error codes without logging prompts, replies or credentials. An upstream disconnect after partial output remains a failure: the bridge does not invent a successful completion or replay a possibly accepted generation request. Upstream outages, client timeouts and an explicitly configured idle timeout can still interrupt responses. These safeguards apply to the VS Code extension bridge, not the separate experimental standalone script. Stream bytes and intentional newlines are preserved; no automatic newline removal is performed.

Token totals use `prompt_tokens` and `completion_tokens` from upstream JSON or SSE usage data. Requests without usage data are counted but do not receive an invented token estimate. Model tracking is bounded to keep malformed or unusual model names from growing memory without limit.

Expand the token total or historical total to see each model's input, output and total tokens, cache hit rate, and estimated cost. New per-model history survives reloads; older aggregate history remains visible as unattributed usage and cannot be retroactively priced. Cache hit rate is cached input tokens divided by input tokens for requests that report valid cache usage (`prompt_tokens_details.cached_tokens` or `prompt_cache_hit_tokens`). Missing cache reports are unknown, not zero; report coverage is displayed. Streaming cumulative usage is settled once per request.

DeepSeek-V4.1-Flash estimates use the [official DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), checked on 2026-10-08: USD per million tokens, off-peak input $0.15, cached input $0.003, output $0.60; peak rates are twice these values. Each request uses its start time: Monday-Friday 01:00-04:00 and 06:00-10:00 UTC are peak (start inclusive, end exclusive); all other times are off-peak. Chinese public holiday exceptions are intentionally NOT applied, so estimates can differ from official billing on holidays. Requests crossing a boundary retain their starting rate. Expanded model details separate peak and off-peak costs. Previously saved estimates without request times remain explicitly labeled ranges and are not retroactively repriced. Only requests with input, output and valid cached-input counts are priced. Reasoning tokens already included in output are not charged twice. These are official-rate equivalent estimates, not GENAI charges. Other models remain unpriced. Historical estimates retain the prices applied when recorded; future price changes require updating the pricing constants.

## Copilot Models

The **Copilot 模型** tile provides multi-select addition and deletion using the seven presets in `genai-models.json`. It opens the current Profile's configuration through VS Code's built-in command, with manual selection only as a fallback. Addition skips matching local endpoint/model identities; deletion is limited to catalog models on the current port. Confirm the selected names before saving; a timestamped sibling backup is created. Dirty or changed files require retrying. Precise deletion preserves unselected model text and parameters and retains empty provider entries. These operations do not require an active GENAI connection.

## Tests

Run `npm test` for lint, statistics regression tests, and VS Code integration tests. Successful account login and any account-specific MFA must be verified by the user through the extension's password input.