import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const run = promisify(execFile);

// Check the installed Store package before opening the temporary diagnostic listener.
export async function verifyDesktopTarget(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) throw Error('A Windows desktop PID is required');
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; $pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if(!$p -or !$pkg){throw 'Codex process or package not found'}; $expected=Join-Path $pkg.InstallLocation 'app\\ChatGPT.exe'; if($p.Name -ne 'ChatGPT.exe' -or $p.ExecutablePath -ne $expected -or !$p.CommandLine -or $p.CommandLine -match '--type='){throw 'Target is not the installed Codex desktop main process'}; Write-Output 'VERIFIED'`;
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const {stdout} = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide:true, timeout:10000, maxBuffer:1024*1024});
  if (stdout.trim() !== 'VERIFIED') throw Error('Desktop target could not be verified');
}
