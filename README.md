# GENAI Login

GENAI Login is a desktop VS Code extension that connects OpenAI-compatible clients to the University of Macau's [GENAI service](https://chat.genai.um.edu.mo) through a local API bridge. Authentication uses the standard UMPASS sign-in and MFA flow.

This is an independent community project, not an official University of Macau extension. Access requires an authorized university account and remains subject to the service's usage policies.

[User Guide](GENAI-README.md) | [Pricing Reference](PRICING.md) | [Changelog](CHANGELOG.md)

## Features

- **Local API bridge** with model listing, chat completions, streaming responses, and request cancellation.
- **Session management** with saved-session reuse, activity-aware health checks, and automatic authentication recovery.
- **Copilot model configuration** with reviewed presets, explicit confirmation, and configuration backups.
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
3. Run **GENAI Login: Login and connect** and complete any required MFA. A valid saved session skips browser login.
4. Configure your client using the connection details below.

### Client Connection

- **Base URL:** `http://127.0.0.1:58379/v1`
- **API key:** `local-browser-session`
- **Supported endpoints:** `GET /v1/models` and `POST /v1/chat/completions`

The bridge supports streaming chat responses. It is not a complete implementation of the OpenAI API, and browser-origin requests are rejected.

### GitHub Copilot

Run **GENAI Login: Manage Copilot models** to add or remove models in the current VS Code Profile. Presets are defined in [genai-models.json](genai-models.json).

Changes require confirmation and create a backup before saving. Unrelated providers and model settings are preserved; unsaved or concurrently modified configuration files must be resolved before proceeding.

## Configuration

Open VS Code Settings and search for **GENAI Login**.

- **`genai-login.port`**: local bridge port. Default: `58379`; range: `1024-65535`. Changing it requires reloading participating windows and updating client URLs.
- **`genai-login.idleTimeoutSeconds`**: maximum time without upstream response data. Default: `0` (disabled); range: `0-86400`. Applies to new requests and pauses during authentication. This is not a total generation deadline.

### Session Health

Health checks adapt to request activity: normally after two idle minutes, with a five-minute maximum interval during healthy operation. Known token expiry advances the next check. Temporary outages and rate limits use backoff rather than triggering a new login.

Health checks do not extend a fixed server-side token lifetime. Genuine expiry or revocation may require authentication and MFA again. See the [User Guide](GENAI-README.md) for recovery steps.

### Multiple Windows

One VS Code window owns each bridge port. Other windows using the same port display shared status; connection and credential operations must be performed in the owner window. Closing or reloading that window stops the bridge. Ownership is not transferred automatically.

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

`npm test` runs lint checks, Node.js regression tests, and VS Code extension-host tests. Browser authentication tests use intercepted responses; successful university login must be verified separately with an authorized account.

## Contributing

Bug reports and focused pull requests are welcome. Use [GitHub Issues](https://github.com/Petalzu/GenaiLogin/issues) to describe the expected behavior, reproduction steps, extension version, and VS Code version. Include only sanitized diagnostics; never attach passwords, cookies, tokens, or authentication callback URLs.

## License

Licensed under the [MIT License](LICENSE).
