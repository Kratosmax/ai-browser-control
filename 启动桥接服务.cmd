@echo off
chcp 65001 >nul
"C:\Program Files\nodejs\node.exe" "%~dp0server\bridge.mjs" --bridge
pause
