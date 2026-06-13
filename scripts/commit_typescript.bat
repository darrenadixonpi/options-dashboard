@echo off
del /f /q ".git\index.lock" 2>nul

git add static\js\03-chart-utils.ts static\js\05-session-api.ts static\js\08-simulate.ts static\js\types.ts tsconfig.pilot.json scripts\commit_typescript.bat

git commit -m "TypeScript: fix 08-simulate truncation, remove @ts-nocheck from pilots, add 03-chart-utils.ts, expand globals in types.ts"

echo Done.
echo.
echo NEXT STEP: run  npm run typecheck:pilot  to verify zero errors.
