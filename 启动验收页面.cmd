@echo off
chcp 65001 >nul
"C:\Program Files\nodejs\node.exe" "%~dp0test-page\serve.mjs"
pause
