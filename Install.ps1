param([switch]$BuildOnly,[switch]$StartOnLogin,[string]$NodePath)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
if (!$NodePath) { $NodePath=(Get-Command node.exe -ErrorAction Stop).Source }
$NodePath=(Resolve-Path -LiteralPath $NodePath).Path
& $NodePath -e 'if(parseInt(process.versions.node)<24)process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 or later is required.' }
$existing=@(Get-CimInstance Win32_Process -Filter "Name='CodexRecoveryTray.exe'")
if (!$BuildOnly -and $existing.Count) { throw 'A Blue C tray is already running. Disable its protection and exit it before installing another copy.' }
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework 4.x C# compiler is required.' }
$exe=Join-Path $root 'CodexRecoveryTray.exe'
& $compiler /nologo /target:winexe /optimize+ /codepage:65001 "/out:$exe" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.Management.dll (Join-Path $root 'src\CodexRecoveryTray.cs') (Join-Path $root 'src\CodexResponseProtection.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray compilation failed.' }
[IO.File]::WriteAllText((Join-Path $root 'node-path.txt'),$NodePath)
if ($BuildOnly) { Write-Host "Built $exe; no tray launched or startup/desktop settings changed."; exit 0 }
$disabled=Join-Path $root 'codex-response-protection.disabled'
if (Test-Path -LiteralPath $disabled) { Remove-Item -LiteralPath $disabled }
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Blue C Recovery.lnk'))
$link.TargetPath=$exe
$link.WorkingDirectory=$root
$link.Description='Codex recovery: automatic reply redelivery and logged manual recovery'
$link.Save()
if ($StartOnLogin) {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-ItemProperty -Path $key -Name 'CodexBlueCRecovery' -Value ('"'+$exe+'"') -PropertyType String -Force | Out-Null
}
Start-Process -FilePath $exe -WorkingDirectory $root -WindowStyle Hidden
Write-Host 'Blue C is running. Right-click its tray icon for protection status and logs.'
