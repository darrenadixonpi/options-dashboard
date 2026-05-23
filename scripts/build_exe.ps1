# Build a portable Windows folder bundle (PyInstaller one-folder).
# Requires: Python 3.10+, .venv recommended.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$py = "python"
if (Test-Path ".venv\Scripts\python.exe") { $py = ".venv\Scripts\python.exe" }

Write-Host "Installing PyInstaller..."
& $py -m pip install pyinstaller

Write-Host "Building portable bundle..."
& $py -m PyInstaller --noconfirm options-dashboard.spec

Write-Host ""
Write-Host "Done. Run:"
Write-Host "  dist\OptionsDashboard\OptionsDashboard.exe --no-browser"
