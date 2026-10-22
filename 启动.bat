@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 正在安装依赖，第一次会稍久...
  call npm install
  if errorlevel 1 (
    echo 安装失败。请先安装 Node.js 后再双击本文件。
    pause
    exit /b 1
  )
)
echo 请保持这个窗口开着。关闭窗口后网页就不能继续转账。
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5173"
call npm run dev
pause
