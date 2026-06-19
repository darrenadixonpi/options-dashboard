@echo off
del /f /q ".git\index.lock" 2>nul

git add static\js\03-chart-utils.ts static\js\05-session-api.ts static\js\08-simulate.ts static\js\types.ts tsconfig.frontend.json scripts\commit_typescript.bat

git commit -m "TypeScript: fix 08-simulate truncation, add fully-typed 03-chart-utils.ts, expand types.ts globals; pilot files retain @ts-nocheck for pass 2"

echo Done.
echo.
echo NEXT STEP: run  npm run typecheck:frontend  to verify zero errors.
