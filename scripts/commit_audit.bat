@echo off
cd /d "H:\Documents\AI\Python Projects\options-app"

del /f /q ".git\index.lock" 2>nul
del /f /q ".git\HEAD.lock" 2>nul

echo Committing app.py fixes...
git add app.py
git commit -m "fix: fractional OCC strikes, yfinance calendar compat, beta cache, DB retention, RISK_FREE"

echo Committing tooling/env...
git add scripts\prep_before_start.py .env.example
git commit -m "chore: add typecheck:frontend to prep script, document RISK_FREE and SNAPSHOT_RETENTION_DAYS"

echo Committing docs + AUDIT...
git add TECHNICAL_EXPLAINER.md CHANGELOG.md DOCKET.md GITHUB.md IMPLEMENTATION_GUIDE.md README.md static\js\README.md AUDIT.md .gitignore
git commit -m "docs: correct Merton params, thresholds, RISK_FREE; add AUDIT.md"

echo Committing Schwab planning doc...
git add docs\SCHWAB_API.md
git commit -m "docs: add SCHWAB_API.md (planning doc, not yet implemented)"

echo.
echo Done. Verifying:
git log --oneline -6
