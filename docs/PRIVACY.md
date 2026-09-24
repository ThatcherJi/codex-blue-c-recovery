# Local access and records

- No analytics, telemetry, remote backend or automatic uploads.
- The only HTTP/WebSocket requests in the helpers connect to the temporary Node inspector on loopback port 9229. That diagnostic interface can execute code in the desktop process; it is held briefly, closed after use, and has a 45-second target-side cleanup lease once the target is verified. Attachment refuses an already occupied port.
- The guard inspects the renderer's pending-request IDs and temporarily holds complete internal response objects in memory. Response bodies are not written to guard logs.
- Guard logs contain timestamps, process/window IDs, compatibility metadata and counts. Loader/recovery error messages can contain local paths. Review any logs before sharing them.
- Manual recovery saves package/process metadata and this tool's logs under `diagnostics/`. It does not copy account credentials, application configuration, conversations or databases.
- An optional per-user login entry and a desktop shortcut point to the extracted folder. `Uninstall.ps1` removes only matching entries.
- The manual fallback stops the identified Store desktop processes and their directly attached, identified app-server processes. Independent CLI sessions are not selected. It does not clear caches, edit configuration, remove history or change drivers/services.

This repository contains the independently written helper code. It does not redistribute Codex application bundles, user diagnostics or test conversations.
