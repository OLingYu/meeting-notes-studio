@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有找到 Node.js。
  echo 请先安装 Node.js 20 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo 正在启动「会议纪要工坊」...
echo 关闭本窗口即可停止服务。
echo.
node "server\index.mjs"
if errorlevel 1 (
  echo.
  echo [提示] 服务异常退出，请查看上面的错误信息。
  pause
)
endlocal
