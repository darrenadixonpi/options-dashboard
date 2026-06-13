@echo off
:: Creates a GitHub Release for the v1.1.0 tag.
:: Requires the GitHub CLI: https://cli.github.com
:: Run once: gh auth login

where gh >nul 2>&1
if %errorlevel% neq 0 (
  echo GitHub CLI ^(gh^) not found.
  echo Install from https://cli.github.com then run: gh auth login
  pause
  exit /b 1
)

echo Creating GitHub Release v1.1.0...

gh release create v1.1.0 ^
  --title "Options Dashboard v1.1.0" ^
  --notes-file docs\RELEASE_NOTES_v1.1.0.md ^
  --latest

if %errorlevel% equ 0 (
  echo Done. Release is live at:
  echo   https://github.com/darrenadixonpi/options-dashboard/releases/tag/v1.1.0
) else (
  echo Release creation failed. Check output above.
)
pause
