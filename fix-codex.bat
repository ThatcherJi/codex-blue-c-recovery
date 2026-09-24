@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex-selfheal.ps1" -ForceRestart -TryComposerRecovery
if errorlevel 1 goto failed
if /i not "%~1"=="--quiet" pause
exit /b 0
:failed
if /i not "%~1"=="--quiet" pause
exit /b 1
