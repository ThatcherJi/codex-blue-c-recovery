$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$exe=Join-Path $root 'CodexRecoveryTray.exe'
# Keep the disable marker even when the desktop is temporarily unreachable.
[IO.File]::WriteAllText((Join-Path $root 'codex-response-protection.disabled'),(Get-Date -Format o))
$trays=@(Get-CimInstance Win32_Process -Filter "Name='CodexRecoveryTray.exe'" | Where-Object {$_.ExecutablePath -eq $exe})
foreach ($tray in $trays) {
  $live=Get-CimInstance Win32_Process -Filter "ProcessId=$($tray.ProcessId)"
  if ($live -and $live.CreationDate -eq $tray.CreationDate -and $live.ExecutablePath -eq $exe) { Stop-Process -Id $tray.ProcessId -Force }
}
$nodeFile=Join-Path $root 'node-path.txt'
$pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if ($pkg -and (Test-Path -LiteralPath $nodeFile)) {
  $desktopExe=Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'
  $mains=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {$_.ExecutablePath -eq $desktopExe -and $_.CommandLine -notmatch '--type='})
  if ($mains.Count -eq 1) {
    $node=(Get-Content -LiteralPath $nodeFile -Raw).Trim()
    & $node (Join-Path $root 'install-codex-response-protection.mjs') "--pid=$($mains[0].ProcessId)" --remove
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Live detach was unavailable. Protection is disabled; the remaining hook disappears when you next close Codex normally.' }
  }
}
$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$value=(Get-ItemProperty -LiteralPath $key -Name CodexBlueCRecovery -ErrorAction SilentlyContinue).CodexBlueCRecovery
if ($value -eq ('"'+$exe+'"')) { Remove-ItemProperty -LiteralPath $key -Name CodexBlueCRecovery }
$linkPath=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Blue C Recovery.lnk'
if (Test-Path -LiteralPath $linkPath) {
  $shell=New-Object -ComObject WScript.Shell
  if ($shell.CreateShortcut($linkPath).TargetPath -eq $exe) { Remove-Item -LiteralPath $linkPath }
}
Write-Host 'Blue C stopped; its matching shortcut and login entry were removed. Codex was not stopped. Source and diagnostic files remain in this folder.'
