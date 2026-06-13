@echo off
cd /d "H:\Documents\AI\Python Projects\options-app"

del /f /q ".git\index.lock" 2>nul
del /f /q ".git\HEAD.lock" 2>nul

echo Committing Phase 6 (Schwab API integration)...
git add schwab_client.py api_schemas.py app.py requirements.txt
git add static\js\05-session-api.ts static\index.html
git add tests\test_schwab_api.py
git add CHANGELOG.md docs\SCHWAB_API.md
git commit -m "feat(6): Schwab OAuth+sync - schwab_client.py, /api/schwab/* routes, connect/sync UI, 16 mocked tests"

echo.
echo Done. Log:
git log --oneline -5
