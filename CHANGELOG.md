# Change Log

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