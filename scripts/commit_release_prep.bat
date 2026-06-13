@echo off
del /f /q ".git\index.lock" 2>nul
git add docs\RELEASE_NOTES_v1.1.0.md scripts\create_github_release.bat
git commit -m "Add GitHub release notes + create_github_release.bat for v1.1.0"
echo Done.
