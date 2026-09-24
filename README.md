# Codex Blue C Recovery

[中文说明](README.zh-CN.md)

A Windows tray workaround for the Codex desktop **Send button staying disabled while the backend is still working**. It combines automatic redelivery of lost internal replies with a blue **C** button for logged manual recovery.

This is the implementation behind [our diagnostic report on openai/codex#46986](https://github.com/openai/codex/issues/46986#issuecomment-5806217749). It operates on the existing desktop window, so users keep working in the original conversation.

## Install

Requirements: Windows 11 x64, the Microsoft Store `OpenAI.Codex` app, Node.js 24+, and the Windows .NET Framework 4.x compiler. No npm dependencies or administrator rights are needed.

1. Download this repository using **Code → Download ZIP**, then extract it to a permanent writable folder, for example on D:.
2. Review the scripts, then double-click **Install.cmd**. It compiles the included C# source locally, creates a desktop shortcut, and starts the tray. Keep the extracted folder in place.
3. Right-click the blue C icon. `自动保护：已启用` means protection is active. If it reports an unsupported build, the automatic guard has not been installed.

Login startup is optional. To enable it, exit any existing Blue C tray and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -StartOnLogin
```

Use `-NodePath 'D:\path\to\node.exe'` when Node is not on PATH. `-BuildOnly` compiles without starting the tray or creating a shortcut/login entry. Do not run a second copy alongside another installation of this guard.

## Use

| Tray action | Effect |
| --- | --- |
| Leave the blue C running | Attach once to each new desktop main process; recover subsequently captured lost replies automatically. |
| Click C / `修复 Codex` | Save local diagnostic metadata, try audited configuration-read recovery, then restart the desktop if that attempt does not recover the reads. **The fallback can interrupt active desktop work.** |
| `检查状态（不重启）` | Check package/process status without stopping Codex. |
| `自动补齐丢失回复（不重启）` | Enable or disable automatic reply protection. |
| `打开最新诊断文件夹` | Open the checkpoint saved before manual recovery. |

Quitting the tray alone does not remove the hook already loaded into Codex. Uncheck automatic protection first, or run `Uninstall.ps1`. Uninstall removes this installation's tray, desktop shortcut and optional login entry, while keeping source/log files and the running Codex application.

## Mechanism and scope

The guard caches complete internal `fetch-response` replies in memory. If the same window still waits for the same request ID after about 2.5 seconds, it redelivers the **original response**. It never resubmits the user message or reruns the operation that generated the response.

Limits: four redeliveries, 45-second retention, 128 replies, 8 MiB total, 256 KiB per reply. Navigation and renderer/window destruction invalidate the cache. Chunked replies and other event types are excluded.

An additional read-retry path helps with configuration responses lost before attachment. It is restricted to the exact previously audited application implementation. Reply redelivery uses separate interface/behavior checks, including isolated success, error and duplicate-response probes. Future official versions have not been validated as a group.

The tool briefly opens a loopback Node diagnostic listener to attach an in-memory hook, verifies the installed desktop target, and closes the listener afterward. It does not patch installed application files. An existing diagnostic listener blocks attachment. This is an unofficial workaround for the captured failure mode; it does not correct the underlying desktop transport defect.

## Evidence and checks

Three original controlled runs each generated 34 replies, delivered 21 to the renderer and left 13 pending. Replaying those replies cleared the pending requests. Five subsequent automatic-recovery tests each recovered 13 replies with zero remaining requests and zero guard-check errors. These were same-machine tests, not broad Windows/version coverage.

The portable package has separate build and offline checks; see [validation](docs/VALIDATION.md) and [privacy](docs/PRIVACY.md).

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -BuildOnly
```
