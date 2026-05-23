# First-time setup: create .venv and install dependencies (Windows).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "============================================"
Write-Host "  Options Dashboard - Setup"
Write-Host "============================================"
Write-Host ""

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "Python not found. Install Python 3.10+ from https://python.org"
}

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment (.venv)..."
    python -m venv .venv
}

$py = Join-Path $PWD ".venv\Scripts\python.exe"
Write-Host "Installing dependencies..."
& $py -m pip install --upgrade pip
& $py -m pip install -r requirements.txt

Write-Host ""
& $py scripts\check_env.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Setup complete. Run start.bat or:"
Write-Host "  .venv\Scripts\python.exe scripts\launch.py"
