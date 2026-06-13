@echo off
del /f /q ".git\index.lock" 2>nul
git add static\js\10-journal.js static\css\app.css app.py .env.example
git commit -m "Journal v2: collapsible strategy groups, cross-day open-date matching, outlier flags"
echo Done.
