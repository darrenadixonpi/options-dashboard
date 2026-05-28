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

:: Prep: deps, frontend bundle, typecheck, pytest (skip with OD_SKIP_PREP=1)
%PYTHON% scripts\prep_before_start.py
if errorlevel 1 (
    echo.
    echo Prep failed. Try: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
    echo Or fast start: set OD_SKIP_PREP=1 ^& start.bat
    pause
    exit /b 1
)
echo.
echo   Stop later: double-click stop.bat  (or Ctrl+C in this window)
echo   Closing the browser does NOT stop the server.
echo.

:: Launch (env check, port check, browser open)
%PYTHON% scripts\launch.py %*
if errorlevel 1 pause
