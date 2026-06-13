@echo off
cd /d "H:\Documents\AI\Python Projects\options-app"

del /f /q ".git\index.lock" 2>nul
del /f /q ".git\HEAD.lock" 2>nul

echo Committing Phase 5.2+5.3 (yfinance resilience + rate limit)...
git add app.py .env.example CHANGELOG.md static\js\main.js
git commit -m "feat(5.1+5.2+5.3): bg refresh daemon+cached endpoint; yfinance retry+backoff; rate-limit token bucket; stale-price fallback"

echo.
echo Done. Log:
git log --oneline -5
