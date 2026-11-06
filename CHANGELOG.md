# Change Log

## [Unreleased]

## [0.0.26-beta.1] - 2026-11-05

- Local test package requested by the user, adding Agents-window support to `0.0.26-beta`. Not published to Marketplace or GitHub Releases.
- Declare `capabilities.agentsWindow.supported` while retaining local UI-host execution and startup activation, so an Agents window can start the bridge without an editor or dashboard and participate in existing shared-window handover. Add automatic-start host assertions, an isolated installed-production Electron regression for Agents-only startup and actual editor-to-Agents handover, and an opt-in Agents host test configuration. Preserve on-demand authentication, saved-session-only handover and local access controls; closing all editor and Agents windows still stops the bridge.
- Local beta package `0.0.26-beta`: include the all-window connection, diagnostic, account-management and browser-session recovery fixes from this work. Not published to Marketplace or GitHub Releases.

- Allow visible diagnostics, account updates and confirmed credential clearing from any up-to-date window. Route diagnostics to the current bridge, synchronize bounded sanitized logs, keep input/confirmation in the invoking window, and coordinate credential commits with instance/revision checks and an expiring shared pause. Prevent new authentication and stale Cookie writes during the commit; preserve cancelled-input and stale-confirmation safety. Model, MCP and application settings remain available from all windows.
- Make browser session verification compatible with response headers lacking `getSetCookie`. Detect identity navigation that destroys the probe's execution context and wait for the callback without restarting login. Classify browser fetch failures as `BROWSER_SESSION_TRANSPORT`, retry within existing bounds, handle opaque redirects as invalid sessions, and retain cancellation and post-submission MFA safeguards. Add real Edge intercepted-route and multi-window regressions; real-device network failures and university MFA require separate verification.
- Keep cold startup on standby even when the last stored connection intent is `connected`. Only windows that observed an active owner may resume its saved session during handover; tolerate a late `connected` revision from that owner without ignoring disconnects. Serve model discovery from bundled presets while idle so opening a client cannot trigger authentication. Chat/image requests and explicit connect remain the triggers. Add real-port close/reopen and VS Code host deactivation regressions while retaining the reasoning-ID fix.
- Keep a stable reasoning identifier on every text fragment in a thinking phase. Reuse upstream IDs when later fragments omit them; otherwise generate a request-local `cot_id` per choice and phase. Retain upstream IDs, signatures and opaque values, and start a new phase after answer, tool, finish or retained non-thinking control events. Copilot 0.73.0 maps missing IDs to empty strings; VS Code's `renderThinkingPart` assigns a timestamp directly to such response objects, making later empty-ID fragments look like different thinking blocks. Replay including that renderer entry reduces a synthetic ten-fragment phase from ten blocks to one with identical text, while genuine phases remain separate. This is source-level compatibility verification, not confirmation that an installed extension or the user's original conversation has been repaired.
- Handle missing or null `delta` on otherwise empty stream choices during active reasoning instead of bypassing empty-control filtering. Preserve usage, real finish events, snapshots and safety/unknown fields. Actual Copilot parser, VS Code response-model and default-header replay changes each synthetic three-part `Finished thinking` case to one timed `Thought for` part without changing text; genuine reasoning/content boundaries remain separate. Add content-free missing-delta counts for real-request verification.
- Treat null `stop_reason` and `token_ids` placeholders on otherwise empty stream choices like null `logprobs`, so they cannot close continuous Copilot thinking. Preserve nonnull values, real output and finish events. Add fragmented-stream and request-level regressions plus content-free counters for these empty placeholders. Offline replay through the installed Copilot parser reduces each synthetic three-block case to one without changing text; existing logs do not prove these fields caused the reported conversation.
- Restore request-triggered automatic connection after a shared disconnect, including when the disconnected intent was saved by an earlier installation. Keep one lightweight loopback listener on standby across reloads and new windows without starting login or health checks. Cancel old requests and authentication on disconnect; only a new authorized API request starts a fresh shared login, with revision checks preventing stale login results from reviving the previous session.

## [0.0.25] - 2026-11-05

- Packaged for local installation at the user's request; not uploaded to Marketplace or GitHub Releases. Include the shared-window connection and performance improvements from 0.0.25-beta.1 and the reasoning-stream fixes below.
- Prevent empty control choices with the standard `logprobs: null` placeholder from prematurely closing continuous Copilot thinking. Preserve nonempty log probabilities, safety metadata, tool calls and real finish events.
- Deduplicate identical reasoning IDs, signatures and opaque metadata already forwarded within the same request and choice when no new reasoning text is present. Preserve first-seen and changed values, and reset tracking when a new reasoning phase starts. Repeated metadata on answer fragments no longer creates empty thinking blocks.
- Add request-level and fragmented-stream regressions. Offline replay through the installed Copilot 0.73.0 parser, provider and VS Code response model confirms fewer synthetic thinking blocks with unchanged text; real upstream interruptions and genuine reasoning/content boundaries are not hidden or replayed.

## [0.0.25-beta.1] - 2026-11-04

- Local test build only; not published to Marketplace or GitHub Releases. Retain the 0.0.25-beta reasoning-stream fix.
- Synchronize connection state in all participating windows even when dashboards are hidden. Allow connecting, recovering and disconnecting the shared bridge from any up-to-date window, using the existing loopback, Host, Origin, Fetch Metadata and Bearer protections plus a per-listener instance check.
- Transfer the bridge to a remaining window when its current window exits. Verify only the saved session during handover; never automatically repeat MFA for missing, invalid or unfinished authentication. Preserve saved-session-only retries after temporary transport failures. Active requests in a closing window can still be interrupted and are never replayed.
- Persist a per-port connection intent with atomic replacement, revision checks and a bounded cross-window lock. Global disconnect survives window closure and reload, and late login results cannot undo it. Store no credentials or cookies in this record; retain independent usage-history files.
- Cache unchanged control records using file identity and nanosecond timestamps; stable polling performs only a metadata check without locking or reading JSON. Hidden windows request a compact status without history or model-usage aggregation. Preserve two-second handover detection and locked reads after changes.
- Defer HTTP, statistics and stream modules until their first use. Idle activation, brief status and disposal leave statistics, history and authentication unloaded. Use a bounded native loopback HTTP client for shared status and commands instead of initializing fetch in every observing window; retain cancellation, response limits and no redirects.
- Reject delayed disconnect commands using control revisions, ignore stale synchronization results after local stop, and keep disconnect independent of automatic takeover. Reuse one connecting intent across simultaneous window requests. Consolidate duplicate window fixtures and handover tests while retaining access, cancellation, MFA and stale-result coverage.
- Add real-loopback multi-window disconnect, hidden-window handover, competing replacement, authentication safety, access-control and responsive dashboard regressions, plus production-module and isolated VS Code host checks.

## [0.0.25-beta] - 2026-11-04

- Local test build only; not published to Marketplace or GitHub Releases.
- Preserve upstream reasoning IDs, signatures and opaque metadata without generating new protocol fields. Keep reasoning state separate across choices and requests, and retain answer text and tool-call boundaries.
- Prevent empty control deltas during reasoning from prematurely closing Copilot's thinking block. Preserve actual text, tool calls, finish events, usage accounting, cancellation, backpressure and bounded SSE decoding.
- Add reasoning continuity, concurrent-request isolation, upstream metadata and byte-fragmentation regressions, including direct production-bundle coverage.

## [0.0.24] - 2026-10-29

- Match request-model statistics parsing to the bridge's 20 MiB request limit so large valid conversations retain their model name. Missing or invalid model names still record as unknown without rejecting requests.
- Price DeepSeek-V4.1-Flash-1017 using the existing DeepSeek-V4.1-Flash rates and peak schedule. Use off-peak pricing when the request start time is unavailable and display a single estimate instead of a range.
- Display total and per-model input/output token usage in millions (M), preserving exact stored counts. Add a historical estimated USD total with an explicit note for unpriced usage.
- Keep the dashboard first render independent of history IO. Read a persisted total cache before background window-file validation, reuse unchanged records, and coalesce cache updates while retaining independent per-window accounting and recovery from stale or damaged caches.
- Reuse the loaded history base across request updates, avoid an extra history-buffer copy, reduce temporary allocations in streaming diagnostics, and skip unchanged dashboard DOM writes. Preserve model-cap ordering, live legacy-storage updates, token counts and diagnostic fields.
- Forward upstream retry hints and request IDs through a header allowlist; parse request metadata once, reuse single body chunks and release concatenation inputs. Share SSE JSON decoding between usage diagnostics and mixed-reasoning normalization, retain received tail usage on failed streams, and keep Cookie-expiry checks off the per-chunk activity path.
- Add configurable FIFO admission for active requests, waiting requests and reserved request-body bytes before authentication or body buffering. Shrink upload reservations after assembly, remove cancelled or expired waiters, return retryable local overload responses, and recheck authentication cooldowns after admission. Preserve original request bytes for the existing bounded HTTP 401 recovery without replaying partially delivered responses.
- Replace the DeepSeek chat preset with DeepSeek-V4.1-Flash-1017, including its display name and default reasoning setting. Retain old-model history, pricing and configuration removal support.
- Update Undici to 7.30.1 and the MCP SDK dependency tree to body-parser 2.4.0, fast-uri 3.1.9 and qs 6.17.1 to resolve the reported production-dependency security advisories; the production dependency audit reports no known vulnerabilities.
- Keep historical data corrections outside the extension; no automatic migration, model reassignment or historical repricing is included.

## [0.0.23]

- Use the same headless Edge connection flow for the first automatic request and ordinary manual Connect. Start the browser before any Node session check, import saved cookies, and reuse valid sessions without repeating UMPASS/MFA. Visible diagnostics remain the only visible-browser entry.
- Verify the browser session through Edge's network and synchronize refreshed cookies before closing the authentication helper. Keep the original prompt waiting for the shared login and forward it once verification succeeds.
- Back off temporary initial-connection failures across requests from 30 seconds to five minutes, preserve Retry-After, and log one failure per connection attempt instead of per waiting caller. Preserve cancellation, access controls, rate limits and the stop-after-credential-submission safeguard.
- Add matching manual/automatic parameters, first-prompt continuation, real Edge cookie reuse/refresh, concurrent cancellation and cooldown regressions. Anonymous probes reproduced immediate Node connection resets while Edge could return HTTP; service/network availability and real university MFA remain external requirements, not guaranteed successes.

## [0.0.22]

- Distinguish the 30-second session-check network deadline from the outer login/MFA deadline. A timed-out initial check no longer disables future automatic connections or claims that verification failed.
- Retry a timed-out saved-session check once after a one-second pause. Keep the overall login deadline, concurrent-login sharing, cancellation, rate limits and no-automatic-MFA-on-unavailable-checks protections. If checks remain unavailable, return HTTP 503 and permit the next request to connect; explicit reconnect can still use the browser fallback.
- Preserve the stop-after-credential-submission safeguard for initial authentication failures as well as reauthentication. Display separate network-check and post-login verification messages; report native timeout/abort names instead of UNKNOWN when their numeric DOMException codes are present.
- Add deadline-origin, timeout recovery, persistent failure, cancellation, concurrent request, 401 transition, dashboard and VS Code host regressions, including the actual production login module.

## [0.0.21]

- Recover an existing connection after three consecutive unavailable session checks with one bounded browser recovery per outage. Do not use this fallback for forbidden responses, rate limits, or responses carrying Retry-After.
- Retry temporary automatic-login failures after backoff, at most twice, instead of immediately requiring a manual disconnect. Preserve Retry-After on local HTTP 503 recovery responses and share the recovery across callers.
- Stop automatic retries after credential submission, incomplete MFA, rejected credentials, unknown errors, or exhausted recovery attempts. Preserve the browser failure's retry safety and network code across the helper process.
- Allow Connect to recover a failed existing connection without closing the listener, aborting active streams, or resetting usage. Show a reconnect action and distinguish scheduled login retries from health-check failures.
- Ignore delayed HTTP 401 and health-check results from a previous session after successful reauthentication. Add recovery, cooldown, cancellation, browser-helper, MFA-safety and responsive dashboard regressions; never replay partially delivered responses.

## [0.0.20]

- Start browser authentication at the official GENAI home page and use the WebUI UMPASS button instead of navigating directly to the OIDC handler. Distinguish the sign-in page from an authenticated callback in login diagnostics and the dashboard.
- Recover from temporary HTTP 502/503/504 entry-page failures with at most two retries before credential submission. Respect Retry-After and cancellation, reject persistent error pages promptly, and require a token before checking the callback session.
- Retry temporary saved-session and callback-check failures at most twice within a bounded check. An explicit Connect may open the home page after repeated gateway or connection failures; automatic connection and keepalive failures do not use this fallback to trigger MFA.
- Add real Edge regressions for home-page and OIDC recovery, English/Chinese sign-in, persistent errors, cancellation, rate limits and the existing MFA flow. Preserve error status and Retry-After across the authentication helper process.

## [0.0.19]

- Recognize the Open WebUI `/auth` login page, including redirect query parameters and a trailing slash, as a trusted login redirect during session checks. Stop before following the login page and request authentication instead of reporting a temporary session-service failure.
- Preserve the existing OIDC login entry point and add regression coverage for both login paths.

## [0.0.18]

- Further reduce standby work by delaying history/random-key initialization and streaming internals. Prefer tree-shakeable official ESM dependency exports, deduplicate the MCP validator runtime, share a fixed drawing-tool schema and compile its input validator only on actual tool calls.
- Reuse unchanged dashboard lists and time formatters, stop the uptime timer when disconnected or hidden, avoid redundant image-download chunk copies, and decode/save generated MCP images sequentially with the original cancellation, format, size and rollback checks preserved.
- Add a one-click dashboard action and command to enable a native VS Code drawing MCP provider for Qwen Image 2.1. The embedded Streamable HTTP server uses the existing authenticated loopback bridge, with no separate Node.js/npm or ImageForge setup and no changes to other MCP servers.
- Expose `generate_image` with prompt, size and image-count inputs, image previews and original-file saving in local extension storage. Preserve MCP trust/approval, lazy authentication, access restrictions, cancellation and image limits; load the official MCP SDK only when an enabled MCP endpoint is requested.
- Build small, separate on-demand CommonJS runtime bundles instead of shipping and resolving the complete general-purpose dependency tree. Keep the Playwright runtime and assets intact; defer dashboard templates, network dependencies and legacy HTML form parsing until needed.
- Run browser authentication in a short-lived child process with local IPC for credentials and Cookie updates. Normal verification, cancellation, startup failure and manually closing diagnostic Edge release the helper without retaining Playwright in the extension host; valid saved sessions do not spawn it.
- Cache file-history aggregation until usage or reloaded records change, retain defensive snapshot copies and live legacy-storage semantics, remove unnecessary owner-window polling, and avoid duplicate login-wait controllers and unchanged-session serialization on the connected request path.
- Add production-bundle transport, browser-helper and history-cache regressions, including real Edge lifecycle checks and a VS Code host cancellation check without university network access.
- Start a lightweight loopback listener after VS Code startup and connect lazily when Copilot chat models, MCP image tools or model-discovery clients send their first authorized API request. Idle activation does not read credentials, load authentication dependencies, start Edge or schedule health checks.
- Share one initial login across concurrent requests, release cancelled callers without replaying their requests, preserve manual connection and diagnostic commands, and stop repeated MFA after verification failure until an explicit connection attempt.
- Show the idle listener as a disconnectable standby state. Explicit disconnect closes the port until reconnect or reload; additional windows share the listener owner's status without logging in or taking over its port.
- Add simulated and real-loopback regression coverage for lazy startup, first chat/image/model requests, access checks, concurrent login, cancellation, failed initialization, disconnect races and idle dashboard controls.

## [0.0.17]

- Retained compatibility for chats sent to an image model id (`qwen-image*`): the bridge translates them into a platform image generation call and returns Markdown image data. Image generation is intended to be called through MCP or an OpenAI Images-compatible client instead of the Copilot model picker.
- The image model accepts the last user message as the prompt, honors an optional `n` (1-6) and `size` (`WxH`), keeps streaming and non-streaming chat behavior, and records the request in the usage dashboard.
- Removed the Qwen-Image preset from Manage Copilot models. One-click configuration continues to offer the seven chat models, while image generation remains available through `/v1/images/generations` for MCP tools and compatible clients.
- Reject empty latest prompts instead of falling back to earlier user messages, keep unreported image token usage unknown, and use the existing backpressure-aware streaming pipeline for image chat replies. Other chat models retain their forwarding behavior.
- Bound image results to six platform file-content URLs and 20 MiB of recognized PNG, JPEG, WebP or GIF data; refresh idle timeouts during downloads and cancel reading when the client disconnects.
- Added regression coverage for model configuration, non-streaming and streamed images, multiple image formats, prompt validation, authentication retries, malformed files, download limits and cancellation.

- Added a local bridge route for image generation: `POST /v1/images/generations` forwards to the platform image endpoint and converts its internal file descriptors into the OpenAI Images `data[].b64_json` shape, so OpenAI-compatible image clients such as imageforge-mcp can generate images through the GENAI session.
- The conversion downloads only platform-hosted result files; cross-origin image references are refused before any request is made.
- Added regression coverage for the conversion, upstream error forwarding and cross-origin refusal.

## [0.0.16]

- Publish the first VS Code Marketplace version while preserving the `Petalzu.genai-login` extension ID.
- Clarify the project description, support links, account requirements and independent community status.
- Streamline project and user documentation with Marketplace-only installation and automatic-update guidance.
- Mark 0.0.16 as the final GitHub Release; future extension versions will be distributed through the Marketplace, with source code and issue tracking remaining on GitHub.

## [0.0.15]

- Fixed HTTP 503 and other temporary health failures being treated as session expiry; health checks now target the authentication endpoint, not the model service.
- Added activity-aware health scheduling with two-minute idle checks, a five-minute maximum healthy gap, token-expiry hints, bounded backoff and Retry-After handling.
- Reject stale failed checks after newer authenticated requests without treating existing stream bytes as new authentication; stop repeating MFA after a failed automatic login and preserve active streams.
- Unified the activity bar, view, page heading and command prefix as GENAI Login while preserving extension and storage IDs.
- Reuse verified saved sessions without loading Playwright; close normal login browsers after verification and replace retained diagnostic browsers before reauthentication.
- Distinguish expired sessions from temporary upstream failures and rate limits, with bounded health checks and keepalive backoff.
- Save changed cookies asynchronously with serialized, coalesced writes; storage failures no longer block successful responses.
- Register request cancellation before authentication/body reading and guard old asynchronous callbacks against replacement connections.
- Preserve legacy history and persist new per-window usage deltas in independent atomic files instead of shared whole-object Memento writes.
- Show explicit dashboard states, login stages and health/storage warnings; disable incompatible actions, confirm credential clearing and release hidden Webviews.
- Add connection, persistence, cross-window history, real Edge dashboard and authentication regression tests.

## [0.0.14]

- Changed the publisher and author to Petalzu; the extension ID is now `Petalzu.genai-login` and does not replace an installed `local-genai.genai-login` in place.
- Added the extension version to the dashboard header.
- Moved the visible diagnostic login action to the end of the action grid.
- Updated repository and documentation links after the GitHub repository rename to Petalzu/GenaiLogin.

## [0.0.13]

- Added optional Duo device confirmation handling: after phone approval, the extension selects "Yes, this is my device" once on the official Duo API host when both exact English or Simplified Chinese choices are visible.
- Added "GENAI: Diagnose login in visible Edge" command and a dashboard action for stalled logins.
- Added sanitized authentication diagnostics: hostname, fixed route category, navigation status/error codes and page structure flags without URL parameters, form values or page text.
- Changed credential submission to not await navigation so the login loop controls the MFA and redirect flow.
- Added regression coverage for Duo device confirmation, diagnostic login mode, and authentication location reporting.

## [0.0.12]

- Added per-model token, cache and reference cost details to the dashboard.
- Added frozen reference pricing for supported models, CNY conversion and DeepSeek peak/off-peak estimates.
- Applied a 90% cached-input fallback when cache usage is missing or invalid.
- Stored historical usage in a single summary without repricing previously saved estimates.
- Added regression coverage for pricing, cache fallback, time boundaries and history persistence.

## [0.0.11]

- Added persistent historical request and token usage totals with a compact dashboard display.
- Preserved usage history across disconnects and credential clearing, with independent records per window.
- Updated streaming response handling and added formatting diagnostics.
- Added regression coverage for historical usage, stream forwarding, and local bridge access.

## [0.0.10]

- Added multi-select Copilot model management with fixed presets, deduplication, precise deletion and backups.
- Added configurable port and idle timeout (disabled by default), plus a port settings tile.
- Hardened streaming cancellation and long-response forwarding without automatic partial replay.
- Added visible-only cross-window synchronization and retained dashboard context.
- Updated activity icon and opaque, layout-stable detail overlays.
- Deferred heavy connection dependencies and added dashboard startup timing diagnostics.
- Published a ready-to-install VSIX through GitHub Releases.

All notable changes to the "genai-login" extension will be documented in this file.

## [0.0.8]

- Replaced the recursive sidebar tree with a Webview connection dashboard.
- Added bounded request/model statistics and upstream usage-based token totals.
- Serialized the 60-second cookie keepalive and persisted refreshed cookies.
- Added regression coverage for SSE parsing, usage accumulation, and model bounds.