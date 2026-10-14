# GENAI Login

User guide for the GENAI Login connection dashboard. For installation, client configuration, development, and licensing, see the [project README](README.md).

GENAI Login is an independent community extension, not an official University of Macau product. An authorized UMPASS account is required.

## Install and Update

Install [GENAI Login](https://marketplace.visualstudio.com/items?itemName=Petalzu.genai-login) from the official Visual Studio Marketplace. In VS Code's **Extensions** view, search for `@id:Petalzu.genai-login` and select **Install**. Enable **Auto Update** in the extension's management menu to receive subsequent versions in VS Code.

Version 0.0.16 is the final GitHub Release. Future extension updates will be distributed through the Marketplace; source code and issue tracking remain on GitHub.

## Connect

1. Open **GENAI Login** in the activity bar.
2. Select **账号设置**, or run **GENAI Login: Save account and password**, and enter your UMPASS credentials.
3. Select **连接 GENAI**, or run **GENAI Login: Login and connect**.
4. Complete the required MFA and wait for the dashboard to show a connected session.

A valid saved session is reused. Otherwise, the extension opens a temporary headless Edge instance and closes it after verification. MFA approval remains your responsibility.

When Duo displays a recognized device-confirmation prompt, the extension selects **Yes, this is my device**. This does not approve MFA or guarantee that future temporary browser sessions will be remembered. Use the extension only on a trusted personal device.

## Manage the Connection

- **Disconnect** stops the bridge and session checks without deleting saved credentials or history.
- **Clear saved credentials and session** requires confirmation, disconnects the bridge, and removes saved credentials and cookies. Usage history remains; the server-side session is not revoked.
- **Manage Copilot models** adds or removes presets in the current Profile. Addition and deletion are separate operations; unchecking a model during addition does not delete it. Configuration changes require confirmation and create a backup.

Only the window that owns the bridge can disconnect it or change credentials. Other windows display read-only connection status. Use the same port across participating windows.

## Session Health

The dashboard displays session health, the next scheduled check, and known expiry information. Successful request activity reduces redundant checks. During healthy operation, checks run after two idle minutes or at least once every five minutes. Temporary failures use backoff and respect server rate limits.

Health checks cannot extend a fixed token lifetime. If authentication expires, one automatic login attempt may require MFA. When verification fails, disconnect and reconnect; the extension does not repeatedly initiate MFA. Already-started streams are not automatically replayed.

Hiding the dashboard does not stop the bridge or session checks. Closing or reloading the owner window does. Finish active requests before upgrading or reloading, and reload every participating window to use the installed version.

## Troubleshooting

### Login Stalls

Disconnect, then run **GENAI Login: Diagnose login in visible Edge** or select **可见诊断**. Inspect the visible browser for verification, consent, or error pages. Diagnostic Edge remains open until disconnect; the login deadline is three minutes.

Open **View > Output** and select **GENAI Login** for sanitized authentication stages and transport error codes. Do not share authentication callback URLs, passwords, cookies, or tokens.

### Port Is Occupied

Check whether another VS Code window already owns the connection. Manage it there, or change **genai-login.port**, reload participating windows, and update client URLs. Only one bridge can listen on a given port.

### Upstream or Session Errors

Temporary service errors do not necessarily indicate expired credentials. Allow the scheduled health retry, or retry the client request after service recovers. If a response was partially delivered, review its content before retrying.

A cookie-storage warning means the current session may continue, but reconnecting after a reload can require a new login. Failed verification requires an explicit disconnect and reconnect.

### Remote Clients Cannot Connect

The bridge listens on the VS Code client machine. A process running on a Remote-SSH host cannot reach it through that host's `127.0.0.1`. Use a client on the local machine; do not expose the bridge to untrusted networks.

## Usage and Cost Estimates

Token statistics use usage data reported by GENAI. Requests without usage are counted without an invented token estimate. Disconnecting or clearing credentials does not reset history.

Cost estimates are reference values, not GENAI charges. Model rates and cache assumptions are documented in [PRICING.md](PRICING.md).