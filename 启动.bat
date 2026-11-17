@echo off
chcp 65001 >nul
title SwarmSite local gateway
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Install it first: https://nodejs.org
  echo   Then reopen this window and double-click this file again.
  echo.
  pause
  exit /b 1
)

rem All Chinese banners are printed by server.js (Node outputs UTF-8),
rem so this file stays ASCII-only and never breaks on any console codepage.
node server.js
echo.
echo   Gateway stopped. Press any key to close.
pause >nul
