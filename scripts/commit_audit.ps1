# commit_audit.ps1 — Run from the repo root to commit all audit-session changes
# Usage: cd "H:\Documents\AI\Python Projects\options-app"; .\scripts\commit_audit.ps1

$root = "H:\Documents\AI\Python Projects\options-app"
Set-Location $root

# Clean up any stale locks first
Remove-Item "$root\.git\index.lock","$root\.git\HEAD.lock" -Force -ErrorAction SilentlyContinue

# 1. Bug fixes in backend
git add app.py
git commit -m "fix: fractional OCC strikes, yfinance calendar compat, beta cache, DB retention, RISK_FREE

- _parse_occ_symbol: regex fix for Fidelity decimal strikes (2.5 not 2.0)
- _calendar_field: handle yfinance .calendar as dict (current) or DataFrame (old)
- RISK_FREE: env-overridable, default 0.037
- init_db: SNAPSHOT_RETENTION_DAYS pruning (default 180d)
- /api/greeks: beta TTL cache (6h per-ticker, 15min SPY)
- __main__: pragma no cover"

# 2. Dev tooling / env
git add scripts\prep_before_start.py .env.example
git commit -m "chore: add typecheck:frontend to prep script, document RISK_FREE and SNAPSHOT_RETENTION_DAYS"

# 3. Docs + AUDIT report
git add TECHNICAL_EXPLAINER.md CHANGELOG.md DOCKET.md GITHUB.md IMPLEMENTATION_GUIDE.md README.md static\js\README.md AUDIT.md .gitignore
git commit -m "docs: correct Merton params, thresholds, RISK_FREE; add AUDIT.md"

# 4. Track Schwab API planning doc
git add docs\SCHWAB_API.md
git commit -m "docs: add SCHWAB_API.md (planning doc, not yet implemented)"

Write-Host "`nAll commits done. Run 'git log --oneline -6' to verify." -ForegroundColor Green
