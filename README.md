# GENAI Login

Manual UMPASS login and local API bridge for desktop VS Code. Open GENAI in the activity bar to use the connection dashboard, save credentials, and connect. The extension uses a temporary headless Microsoft Edge session for the normal MFA flow, keeps that browser session alive until Disconnect, and stores credentials and cookies in VS Code SecretStorage.

The endpoint remains http://127.0.0.1:58379/v1/chat/completions with compatibility API key local-browser-session. Stop the old bridge first. MFA is not bypassed. The dashboard shows port, uptime, bridge requests, models, and upstream-reported token usage. Network failures require retrying the request; authentication expiry triggers one login attempt. Reloading the window stops the bridge, but saved credentials persist. See GENAI-README.md for details.

## Features

- **Manual login flow** — you enter UMPASS credentials, the extension drives the normal OIDC → password → MFA flow; nothing is bypassed or harvested.
- **Local OpenAI-compatible bridge** on `127.0.0.1:58379` with `/v1/models` and `/v1/chat/completions`, including SSE streaming passthrough.
- **Connection dashboard** (webview) showing status, port, uptime, request count, per-model usage, keepalive state, and upstream-reported token usage.
- **SecretStorage only** — credentials and cookie jars never touch plain configuration files or the filesystem.
- **Keepalive** — a serialized 60-second session check persists refreshed cookies and reauthenticates once when the session expires.

## Requirements

- Desktop VS Code (extension kind `ui`; it does not run in Remote/SSH windows).
- Microsoft Edge installed on the machine running VS Code.
- A valid UMPASS account with access to GENAI.

## Install from GitHub Releases

1. Open [the latest release](https://github.com/Petalzu/GenaiLogin/releases/latest).
2. Download the `.vsix` file under **Assets**, not the source ZIP or TAR archive.
3. In VS Code, open **Extensions**, select the **...** menu, then **Install from VSIX...** and choose the downloaded file.
4. Run **Developer: Reload Window**, then open **GENAI** in the activity bar.

Alternatively, install the v0.0.14 package from a terminal:

```bash
code --install-extension genai-login-0.0.14.vsix --force
```

Node.js and npm are not required for a Release installation. Microsoft Edge and a valid GENAI account are still required. When upgrading, finish active conversations before reloading: reloading the owner window stops its bridge. Existing saved credentials and settings are retained.

## Installing from source

```bash
git clone https://github.com/Petalzu/GenaiLogin.git
cd GenaiLogin
npm install
npm test
```

Open the folder in VS Code and press **F5** to run the extension in a development window, or package a VSIX locally:

```bash
npx @vscode/vsce package -o genai-login.vsix
```

Install the generated VSIX from the command line:

```bash
code --install-extension genai-login.vsix --force
```

Or via the VS Code UI: *Extensions* panel → `…` menu → *Install from VSIX…*.

**Upgrading an installed version:** `--force` replaces the extension in place even when the version number is unchanged. Reload the VS Code window afterwards so the new code takes effect.

**Packaging notes:**

- Run `npm install` first; `vsce` bundles runtime dependencies into the VSIX (approximately 6 MB compressed for v0.0.10). `devDependencies` are excluded automatically.
- Do **not** pass `--no-dependencies`: it skips dependency resolution and produces a VSIX without `node_modules`, which fails at runtime with missing-module errors.
- `vsce` renames `README.md` → `readme.md`, `LICENSE` → `LICENSE.txt`, and `CHANGELOG.md` → `changelog.md` inside the VSIX; the content is unchanged. `test/` and local-only files are excluded via `.vscodeignore`.

## Usage

1. Open the **GENAI** view in the activity bar.
2. Save your UMPASS account and password (stored in SecretStorage).
3. Press **Connect**. A temporary headless Edge completes the login/MFA flow and remains available until Disconnect.
4. Point OpenAI-compatible clients at `http://127.0.0.1:58379/v1` with the API key `local-browser-session`.

If a saved cookie jar is still valid, login is skipped entirely.

## Extension Settings

### Copilot Model Management

Use the **Copilot 模型** dashboard tile or **GENAI: Manage Copilot models** command to add or delete multiple models. The fixed presets are in [genai-models.json](genai-models.json); no upstream connection is required. Choose Add or Delete; the extension invokes VS Code's built-in command to open the current Profile's model configuration. Manual file selection is offered only if automatic resolution fails.

Adding skips models already configured at the current loopback endpoint by ID or model name. Unchecking an existing model does not delete it. Deleting is a separate multi-select operation restricted to catalog models at that endpoint; other ports and services are preserved. Associated per-model settings are removed only when no remaining model in that provider uses the ID. Empty provider entries are retained.

Both operations require confirmation and create a timestamped sibling `.bak` file before saving. Unsaved or concurrently changed files are rejected. Deletion removes only selected model text and unused model settings, preserving unselected model text and parameters; a semantic check rejects unrelated parameter changes. If Copilot does not refresh automatically, reload the window after active requests finish.

Open VS Code Settings and search for `GENAI Login`:

- `genai-login.port`: default `58379`, valid range `1024` through `65535`. After changing it, reload participating windows and update the client's base URL to `http://127.0.0.1:<port>/v1`. Reloading the owner interrupts active requests; wait for them to finish first.
- `genai-login.idleTimeoutSeconds`: default `0` (disabled), range `0` through `86400`. Applies to new requests. A positive value limits time without upstream data and resets as data arrives. There is no total generation deadline.

Model requests use a separate HTTP pool without implicit response-header/body timeouts. Cancellation still releases upstream resources. Network failure, upstream termination, client timeouts and closing the owner window can still interrupt a response; this is not a guarantee of indefinite connectivity. Partial generations are never automatically replayed.

Other windows synchronize shared statistics only while the GENAI view is visible, immediately on opening and then every two seconds. Hiding it stops polling. Use the same configured port across windows.

Dashboard metric details float downwards with an opaque background without resizing or moving the cards. The dashboard retains its Webview when hidden; lightweight startup registration and inline initial state reduce first-open work without starting a connection. Streamed content is forwarded byte-for-byte, including intentional newlines and code blocks. SSE frame separators are not answer text. Unexpected displayed line breaks require comparing an affected response with the client's rendering; the bridge does not strip model formatting.

## Known Issues

### Historical Usage

The history card persists total chat request attempts and reported input/output tokens in VS Code extension global storage. Counts begin when this feature is installed; previous usage cannot be reconstructed. Requests count once before forwarding, including failed attempts; authentication retries do not count twice. Token totals update when responses settle, and missing usage is not estimated. Disconnecting or clearing account credentials does not erase history. Windows write independent records to avoid overwriting each other's totals; visible observers receive the owner's history snapshot. Storage sharing follows VS Code's profile/global-storage behavior and is not a cross-device account total. Abrupt termination can lose pending writes or unfinished response usage.

- Only one VS Code window can own port 58379; stop the other bridge first.
- Network failures are not retried automatically — resend the request.
- Streamed conversations are not replayed after an automatic relogin.
- The compatibility key `local-browser-session` is not a strong boundary against other local programs; never expose the port beyond loopback.

## How it works

```
Chat client ──> 127.0.0.1:58379 (Host/Bearer/Fetch-Metadata checks)
                    │
                    ▼
        auth.js / browser-auth.js
        (cookie jar + headless Edge login)
                    │
                    ▼
        https://chat.genai.um.edu.mo/api/v1
```

`auth.js` performs form-based OIDC/SAML login with fetch and a `tough-cookie` jar. `browser-auth.js` falls back to a temporary headless Edge session via `playwright-core` when the form flow hits interactive steps (e.g. MFA). Upstream hosts are pinned to `chat.genai.um.edu.mo`, `login.um.edu.mo`, and `websso.um.edu.mo`; redirects to any other host are refused.

The local bridge enforces:

- Host header must be exactly `127.0.0.1:<configured port>` (default `58379`)
- `Origin` header must be absent (blocks browser-based callers)
- `Sec-Fetch-Site` must be `none` or absent
- `Authorization: Bearer local-browser-session`

## Security notes

- Credentials and cookie jars are stored in VS Code SecretStorage; **Clear** removes both stored values but does not revoke the server-side session.
- No telemetry, no analytics, no data leaves the machine except requests destined for the pinned GENAI hosts.

## License

MIT — see [LICENSE](LICENSE).
