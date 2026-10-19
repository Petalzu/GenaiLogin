# GENAI Login

GENAI Login is a desktop VS Code extension that connects OpenAI-compatible clients to the University of Macau's [GENAI service](https://chat.genai.um.edu.mo) through a local API bridge. Authentication uses the standard UMPASS sign-in and MFA flow.

This is an independent community project, not an official University of Macau extension. Access requires an authorized university account and remains subject to the service's usage policies.

[User Guide](GENAI-README.md) | [Pricing Reference](PRICING.md) | [Changelog](CHANGELOG.md)

## Features

- **Local API bridge** with model listing, chat completions, streaming responses, and request cancellation.
- **On-demand connection** for Copilot chat models and MCP image tools, with saved-session reuse, activity-aware health checks, and automatic authentication recovery.
- **Copilot model configuration** with reviewed presets, explicit confirmation, and configuration backups.
- **One-click drawing MCP** for Qwen Image 2.1, with an embedded server, image previews and local file saving. No separate Node.js, npm or ImageForge installation is required.
- **Connection dashboard** with login progress, session health, model usage, and persistent token statistics.
- **Credential storage** through VS Code SecretStorage rather than plain-text settings.

## Requirements

- Desktop VS Code 1.110 or later.
- Microsoft Edge installed on the VS Code client machine.
- A UMPASS account authorized to access GENAI.

The extension runs in the local UI extension host, including when the workspace is connected through Remote-SSH. Its bridge listens on the client machine, not the remote host.

## Installation

GENAI Login is available on the official [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Petalzu.genai-login).

1. Open **Extensions** in VS Code.
2. Search for `@id:Petalzu.genai-login` and select **GENAI Login** by **Petalzu**.
3. Select **Install**.

Alternatively, install directly from the Marketplace using the command line:

```sh
code --install-extension Petalzu.genai-login
```

Enable **Auto Update** in the extension's management menu to receive future versions directly in VS Code. Existing users should verify this option is enabled. Automatic updates follow VS Code's update settings.

**Version 0.0.16 is the final GitHub Release.** Future extension versions will be distributed through the Marketplace. This repository remains the home for source code, changelogs, and issue tracking.

Node.js and npm are not required to install or use the extension. Finish active requests before restarting extensions or reloading participating windows. Saved credentials, settings, and usage history are retained.

## Quick Start

1. Open **GENAI Login** in the activity bar.
2. Run **GENAI Login: Save account and password** to store your UMPASS credentials.
3. Configure your client using the connection details below and send a request. The bridge connects in the background; complete any required MFA. A valid saved session skips browser login.

Manual connection is optional. **GENAI Login: Login and connect** can prepare the session in advance. If no credentials have been saved, the first API request prompts for them in VS Code. Passwords remain in SecretStorage, not in client or MCP configuration.

### Client Connection

- **Base URL:** `http://127.0.0.1:58379/v1`
- **API key:** `local-browser-session`
- **Supported endpoints:** `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/images/generations`

The bridge supports streaming chat responses. Image generation follows the platform's configured image engine (for example Qwen-Image); its response is converted to the OpenAI Images shape (`data[].b64_json`) so OpenAI-compatible image clients can consume it. It is not a complete implementation of the OpenAI API, and browser-origin requests are rejected.

Image results are limited to six files and 20 MiB of decoded image bytes per request. Only platform file-content URLs and recognized PNG, JPEG, WebP or GIF bytes are accepted. Image requests are counted in the dashboard, but token usage is left unknown rather than estimated.

### GitHub Copilot

Run **GENAI Login: Manage Copilot models** to add or remove models in the current VS Code Profile. Presets are defined in [genai-models.json](genai-models.json).

Copilot presets include chat models only. For drawing, select **添加绘画 MCP** in the GENAI Login dashboard or run **GENAI Login: Add Qwen Image 2.1 drawing MCP server**. This enables the extension's native MCP provider in user settings without rewriting `mcp.json` or changing other MCP servers. In Copilot Agent, select a tool-capable chat model and enable the **GENAI / Qwen Image 2.1** server's `generate_image` tool. VS Code may require server trust and tool-call approval; those checks are not bypassed.

The embedded MCP server uses the current bridge port and calls `/v1/images/generations` with `model: qwen-image-2.1`. It returns image previews and saves original files under `generated-images` in the extension's local data directory; the result includes the file paths. No image chat-model registration or separate MCP process is needed. The platform's configured image engine determines the actual model used. See the [User Guide](GENAI-README.md#image-generation-with-mcp) for connection requirements.

Changes require confirmation and create a backup before saving. Unrelated providers and model settings are preserved; unsaved or concurrently modified configuration files must be resolved before proceeding.

### Background Connection

After VS Code finishes starting, the extension opens a loopback listener without reading credentials, loading the authentication dependencies, starting Edge, or scheduling health checks. The first authorized request to `/v1/models`, `/v1/chat/completions`, or `/v1/images/generations` initializes the session. Internal status queries and rejected requests do not initiate login.

Production builds keep the dashboard, Cookie session, network client and model configuration in separate on-demand bundles. History initialization waits for a status/dashboard request or an API connection, and streaming dependencies load when a response needs them. When browser authentication is necessary, a short-lived helper process owns Playwright and Edge; it exits after normal verification so those dependencies do not remain in the extension host. Credentials and Cookie updates travel through local IPC, not command-line arguments or temporary files. A diagnostic helper stays open only while its browser is retained.

The drawing MCP bundle uses the official SDK's ESM distribution with a fixed tool schema and one shared, lazily compiled input validator. Image decoding and file saving proceed one image at a time rather than retaining every decoded image. The dashboard reuses unchanged lists and runs its uptime timer only while connected and visible.

Concurrent requests share one login. Cancelling a waiting client releases that request without cancelling the shared login or forwarding the cancelled request later. The first request can wait for MFA, so the client's own request timeout must allow enough time for verification. The extension must be enabled and a desktop VS Code window must remain open; an HTTP request cannot launch a closed VS Code application.

**Disconnect** closes the listener and session checks until you explicitly connect again or reload the window. Failed MFA or rejected credentials require an explicit connection attempt instead of repeatedly triggering verification on client retries. Temporary connection failures leave the listener available for later requests.

## Configuration

Open VS Code Settings and search for **GENAI Login**.

- **`genai-login.port`**: local bridge port. Default: `58379`; range: `1024-65535`. Changing it requires reloading participating windows and updating client URLs.
- **`genai-login.idleTimeoutSeconds`**: maximum time without upstream response data. Default: `0` (disabled); range: `0-86400`. Applies to new requests and pauses during authentication. This is not a total generation deadline.
- **`genai-login.imageMcp.enabled`**: enable the built-in Qwen Image 2.1 MCP provider. Default: `false`; the one-click command sets it to `true`. Disable it in user settings to remove the provider's server from discovery. Generated files are retained until you delete them.

### Session Health

Health checks adapt to request activity: normally after two idle minutes, with a five-minute maximum interval during healthy operation. Known token expiry advances the next check. Temporary outages and rate limits use backoff rather than triggering a new login.

Health checks do not extend a fixed server-side token lifetime. Genuine expiry or revocation may require authentication and MFA again. See the [User Guide](GENAI-README.md) for recovery steps.

### Multiple Windows

One VS Code window owns each bridge port, including while waiting for the first request. Other windows using the same port display shared status; connection and credential operations must be performed in the owner window. Closing the owner window stops the bridge; reloading it recreates the idle listener. Ownership is not transferred automatically to an already-open window.

## Usage Statistics

The dashboard records request attempts and token usage reported by GENAI. Missing token usage is not estimated. History is local to the extension storage and survives disconnects and credential clearing; unfinished responses or pending writes may be lost if VS Code exits unexpectedly.

Cost estimates use reference model rates and documented assumptions. They are not GENAI billing records. See [PRICING.md](PRICING.md) for rates and estimation details.

## Security and Limitations

- Credentials and cookies are managed through VS Code SecretStorage, not plain-text configuration. Clearing them does not revoke the server-side session.
- The bridge listens only on `127.0.0.1`. Its compatibility API key is not a security boundary against other local programs; do not expose or forward the port to untrusted networks.
- Authentication follows the university's sign-in process and does not bypass MFA. Temporary browser sessions do not guarantee remembered-device behavior across reconnects.
- Failed or partially delivered generations are not automatically replayed. Review any partial output before retrying a request.
- Requests remain subject to upstream availability, client timeouts, and account permissions.

## Development

Use Node.js 24 and npm. Microsoft Edge is required for browser regression tests.

```sh
git clone https://github.com/Petalzu/GenaiLogin.git
cd GenaiLogin
npm ci
npm test
```

`npm test` runs lint checks, builds the production modules in `dist`, and runs Node.js regression tests and VS Code extension-host tests. `npm run build` rebuilds the modules; packaging runs the same build automatically. Keep the Playwright runtime assets external rather than bundling or pruning its internal files.

Browser authentication tests use intercepted responses and cover both in-process form logic and the isolated browser helper. Successful university login must be verified separately with an authorized account. Development benchmarks must distinguish JS heap, process RSS, dependency loading and overall VS Code startup; lower extension loading time is not a guarantee for total window startup time.

## Contributing

Bug reports and focused pull requests are welcome. Use [GitHub Issues](https://github.com/Petalzu/GenaiLogin/issues) to describe the expected behavior, reproduction steps, extension version, and VS Code version. Include only sanitized diagnostics; never attach passwords, cookies, tokens, or authentication callback URLs.

## License

Licensed under the [MIT License](LICENSE).
