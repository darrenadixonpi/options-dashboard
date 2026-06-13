@echo off
del /f /q ".git\index.lock" 2>nul

REM Stage all modified tracked files
git add api_schemas.py
git add docs\SCHWAB_API.md
git add requirements.txt

REM Stage untracked files
git add schwab_client.py
git add tests\test_schwab_api.py
git add scripts\commit_audit.bat
git add scripts\commit_audit.ps1
git add scripts\commit_journal_v2.bat
git add scripts\commit_phase4.bat
git add scripts\commit_phase5.bat
git add scripts\commit_phase6.bat
git add scripts\commit_release_prep.bat

REM Stage anything else untracked (scripts, docs, static changes)
git add scripts\
git add static\
git add docs\
git add tools\
git add tests\

git status

git commit -m "chore: mop up uncommitted Phase 6-7 files and scripts"

echo.
echo Now pushing all commits to origin/main...
git push origin main

echo.
echo Done. Check above for any errors.
pause
