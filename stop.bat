@echo off
title Stop Options Dashboard
setlocal

set "PYTHON=python"
if exist ".venv\Scripts\python.exe" set "PYTHON=.venv\Scripts\python.exe"

echo Stopping Options Dashboard...
%PYTHON% scripts\stop.py %*
set "RC=%ERRORLEVEL%"
if %RC% neq 0 pause
exit /b %RC%
