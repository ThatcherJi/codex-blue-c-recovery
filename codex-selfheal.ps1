# Public recovery wrapper: collect local metadata, try audited reads, then restart only the desktop.
param([switch]$NoRestart,[switch]$ForceRestart,[switch]$CaptureOnly,[switch]$TryComposerRecovery)
$ErrorActionPreference='Stop'
$toolsRoot=$PSScriptRoot
$logFile=Join-Path $toolsRoot 'codex-selfheal.log'
function Log([string]$message) {
  "$(Get-Date -Format o) $message" | Out-File -LiteralPath $logFile -Append -Encoding utf8
}
function Get-DesktopProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='codex.exe'" | Where-Object {
    ($_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -eq $desktopExe) -or
    ($_.Name -eq 'codex.exe' -and $_.ExecutablePath -match '\\OpenAI\\Codex\\bin\\[^\\]+\\codex\.exe$' -and $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)')
  })
}
function Save-Diagnostics {
  $folder=Join-Path (Join-Path $toolsRoot 'diagnostics') (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
  [IO.Directory]::CreateDirectory($folder) | Out-Null
  $before | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Depth 4 | Out-File (Join-Path $folder 'processes-before.json') -Encoding utf8
  $pkg | Select-Object Name,Version | ConvertTo-Json | Out-File (Join-Path $folder 'app-version.json') -Encoding utf8
  foreach ($name in @('codex-response-guard-state.json','codex-response-guard.log','codex-response-protection-loader.log','codex-selfheal.log')) {
    $file=Join-Path $toolsRoot $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $folder $name) }
  }
  "Recovery checkpoint: $(Get-Date -Format o)`r`nMetadata and tool logs were saved before recovery. Conversations and application settings are not deleted or backed up by this script. Restart may interrupt active desktop work. Review local logs before sharing them." | Out-File (Join-Path $folder 'READ-ME.txt') -Encoding utf8
  $folder | Out-File (Join-Path $toolsRoot 'codex-last-diagnostic.txt') -Encoding utf8
  Log "SNAPSHOT $folder"
  Write-Host "Saved diagnostics: $folder"
  return $folder
}
if ($NoRestart -and $ForceRestart) { throw 'NoRestart and ForceRestart cannot be combined.' }
if ($TryComposerRecovery -and !$ForceRestart) { throw 'TryComposerRecovery requires explicit ForceRestart as fallback.' }
$pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (!$pkg) { throw 'The OpenAI.Codex Store package is not installed for this user.' }
$desktopExe=Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'
$before=@(Get-DesktopProcesses)
Log "CHECK version=$($pkg.Version) processes=$($before.Count)"
if (!$ForceRestart -and !$CaptureOnly) { Write-Host 'Check complete. No processes stopped or application settings changed.'; exit 0 }
$main=@($before | Where-Object {$_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch '--type='})
if ($main.Count -gt 1) { throw 'Multiple desktop main processes found; automatic restart was cancelled.' }
$appId=(Get-AppxPackageManifest -Package $pkg).Package.Applications.Application | Select-Object -First 1 -ExpandProperty Id
if (!$appId) { throw 'Cannot resolve the Codex application launch entry; restart cancelled.' }
$snapshot=Save-Diagnostics
if ($CaptureOnly) { exit 0 }
if ($TryComposerRecovery -and $main.Count -eq 1) {
  try {
    $node=Get-Content -LiteralPath (Join-Path $toolsRoot 'node-path.txt') -Raw
    $resultPath=Join-Path $snapshot 'renderer-recovery.json'
    & $node.Trim() (Join-Path $toolsRoot 'inspect-codex-state.mjs') "--pid=$($main[0].ProcessId)" --repair "--out=$resultPath" *> (Join-Path $snapshot 'renderer-recovery.log')
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $resultPath)) {
      $result=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
      if ($result.renderer.state.recovery.recovered -eq $true) {
        Log 'RECOVERED without restart'
        Write-Host 'The configuration reads recovered. Current tasks were kept; try sending again.'
        exit 0
      }
    }
  } catch { Log "Live recovery unavailable: $($_.Exception.Message)" }
}
$gui=@($before | Where-Object {$_.Name -eq 'ChatGPT.exe'})
$guiIds=@($gui.ProcessId)
$backend=@($before | Where-Object {$_.Name -eq 'codex.exe' -and $guiIds -contains $_.ParentProcessId})
Write-Host 'Live recovery did not resolve the blocked reads. Restarting the desktop; active desktop work may be interrupted.'
foreach ($entry in @($gui)+@($backend)) {
  $live=Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ProcessId)" -ErrorAction SilentlyContinue
  if ($live -and $live.CreationDate -eq $entry.CreationDate -and $live.ExecutablePath -eq $entry.ExecutablePath) {
    Stop-Process -Id $entry.ProcessId -Force -ErrorAction Stop
    Log "STOPPED desktop PID=$($entry.ProcessId) name=$($entry.Name)"
  }
}
Start-Sleep -Seconds 2
Start-Process ('shell:AppsFolder\'+$pkg.PackageFamilyName+'!'+$appId)
Log "RELAUNCHED; evidence=$snapshot"
Write-Host "Desktop reopened. Diagnostic snapshot: $snapshot"
