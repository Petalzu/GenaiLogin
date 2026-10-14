# Change Log

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