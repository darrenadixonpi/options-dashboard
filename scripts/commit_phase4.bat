@echo off
cd /d "H:\Documents\AI\Python Projects\options-app"

del /f /q ".git\index.lock" 2>nul
del /f /q ".git\HEAD.lock" 2>nul

echo Committing Phase 4.4 tests + docs + package.json esbuild dep...
git add tests\test_smoke.py README.md CHANGELOG.md package.json package-lock.json
git commit -m "test(4.4)+docs: simulate/DB-pruning/beta-cache tests; README API table; CHANGELOG Phase4; add esbuild linux dep"

echo.
echo Done. Log:
git log --oneline -5
