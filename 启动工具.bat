@echo off
title Hand-Carry Tool - Proxy Server

python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3 first.
    pause
    exit /b 1
)

REM Kill any old proxy on port 8765
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8765 "') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo Starting proxy server...
echo Do NOT close this window!
echo.

REM Open browser after 4 second delay (background)
start /b cmd /c "ping -n 5 127.0.0.1 >nul 2>&1 & start http://localhost:8765"

REM Run proxy (foreground - keeps window alive)
python proxy.py
pause
