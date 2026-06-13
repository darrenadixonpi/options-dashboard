@echo off
del /f /q ".git\index.lock" 2>nul

echo === Phase 7 commit ===

git add app.py tax_lots.py static\js\10-phase7.js static\index.html static\js\04-state.js static\js\07-tabs.js CHANGELOG.md DOCKET.md
git commit -m "Phase 7: orders, rules engine, templates, tax lots, VaR, notifications, export"

git add scripts\commit_phase7.bat
git commit -m "Phase 7: add commit_phase7.bat"

echo === Done ===
