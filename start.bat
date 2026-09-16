@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] 首次运行，正在安装依赖（需要下载 Electron 运行时，请稍候）...
  if not defined ELECTRON_MIRROR set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo [2/2] 启动 Command Code 额度监控...
start "" "node_modules\electron\dist\electron.exe" .
