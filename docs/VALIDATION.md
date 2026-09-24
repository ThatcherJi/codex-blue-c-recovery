# Validation

## Original installed implementation — September 23, 2026

Windows 11 x64; Store package `26.917.8451.0`; desktop release `26.917.62051`, build `10789`; reported Electron version `153.0.8010.53`; app-server `0.155.0-alpha.16.3`.

| Experiment | Observation |
| --- | --- |
| Three controlled startup captures | Each: 34 successful internal responses generated, 21 renderer deliveries, 13 requests pending. |
| Redelivery of the original replies | 13 pending requests reduced to zero without rerunning their operations. |
| Five automatic-guard experiments | Each: 13 replies recovered, zero pending requests and zero check errors. |
| New desktop main process | Tray attached again automatically. This was not a test of a different official app version. |

The captured composer blocker was `loading-local-config`. The evidence narrows the failure to reply delivery between the main process and preload/renderer dispatch; it does not identify the exact native drop instruction.

Source report: https://github.com/openai/codex/issues/46986#issuecomment-5806217749

## Public package

The public package keeps the reply-guard algorithm and its compatibility probes. Packaging changes make paths relative to the extracted directory, discover Node at install time, verify the target against the installed Store package, gate manual read retries to the audited implementation, and provide installation/removal scripts. Public manual diagnostics collect metadata/tool logs instead of the original machine-specific full snapshots.

Offline tests use synthetic response objects and query clients. They cover original-object redelivery, request/window identity, navigation invalidation, bounded retries/memory, disabled state, unresponsive renderers, compatibility checks, duplicate replies, and the read-only endpoint allowlist. They never send a message or call a real request handler.

Build, helper-probe and public-package check results are recorded in `VALIDATION-RESULTS.json` after verification. The distributed tray is compiled from source by the user. A fresh install/login cycle and the complete manual restart fallback have not been exercised on a second machine.
