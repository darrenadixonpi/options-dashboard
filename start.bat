@echo off
title Options Dashboard
setlocal EnableDelayedExpansion

echo ============================================
echo   Options Dashboard - Starting...
echo ============================================
echo.

set "PYTHON=python"
if exist ".venv\Scripts\python.exe" set "PYTHON=.venv\Scripts\python.exe"

:: Check if Python is available
%PYTHON% --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3.10+ from python.org
    echo        Or run scripts\setup.ps1 once to create .venv
    pause
    exit /b 1
)

:: Environment check (install deps on first run)
%PYTHON% scripts\check_env.py
if errorlevel 1 (
    echo.
    echo Installing dependencies...
    %PYTHON% -m pip install -r requirements.txt
    %PYTHON% scripts\check_env.py
    if errorlevel 1 (
        echo.
        echo Setup failed. Try: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
        pause
        exit /b 1
    )
)
echo.
echo   Stop later: double-click stop.bat  (or Ctrl+C in this window)
echo   Closing the browser does NOT stop the server.
echo.

:: Launch (env check, port check, browser open)
%PYTHON% scripts\launch.py %*
if errorlevel 1 pause
