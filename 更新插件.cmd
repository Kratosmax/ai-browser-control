@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
node "%~dp0install.mjs" update
if errorlevel 1 (
  echo 更新未完成，请查看上方错误。
  pause
  exit /b 1
)
echo 请在浏览器扩展管理页重新加载扩展，并刷新受控网页。
pause
