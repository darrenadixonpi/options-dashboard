# Ship on GitHub

**Do not share your GitHub password with anyone.** GitHub disabled password-based git push in 2021. You authenticate once on your machine using one of the options below.

---

## What gets published

The repo includes source code, tests, Docker setup, and docs. These stay **local** (`.gitignore`):

- `portfolio.db` — your snapshots / alert log
- `.env` — secrets
- `.venv/`, `node_modules/` — install via setup scripts
- `static/dist/` — built in CI or with `npm run build`

---

## Option A — GitHub website + HTTPS (simplest)

### 1. Create the empty repo on GitHub

1. Go to [github.com/new](https://github.com/new)
2. Repository name: e.g. `options-app` or `options-dashboard`
3. **Private** recommended (personal trading tool)
4. Do **not** add README, `.gitignore`, or license (this project already has them)
5. Click **Create repository**

### 2. Push from this folder

Open PowerShell in the project root:

```powershell
cd "h:\Documents\AI\Python Projects\options-app"

git remote add origin https://github.com/YOUR_USERNAME/options-dashboard.git
git branch -M main
git push -u origin main
```

When prompted for credentials:

- **Username:** your GitHub username
- **Password:** use a **Personal Access Token**, not your account password  
  Create one: GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → `repo` scope

Windows may save the token in Credential Manager after the first successful push.

---

## Option B — GitHub CLI (`gh`)

### 1. Install and log in (one time)

```powershell
winget install GitHub.cli
gh auth login
```

Choose: GitHub.com → HTTPS or SSH → authenticate in the browser.

### 2. Create repo and push

```powershell
cd "h:\Documents\AI\Python Projects\options-app"
gh repo create options-dashboard --private --source=. --remote=origin --push
```

---

## Option C — SSH keys

If you already use SSH with GitHub:

```powershell
git remote add origin git@github.com:YOUR_USERNAME/options-dashboard.git
git branch -M main
git push -u origin main
```

Setup guide: [GitHub SSH keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)

---

## After the first push

- **CI** runs automatically (`.github/workflows/ci.yml`) — pytest, pip-audit, frontend build, typecheck, and Playwright E2E on every push/PR
- **Releases:** GitHub → **Releases** → **Draft a new release** → tag `v1.1.0`, paste notes from [CHANGELOG.md](CHANGELOG.md)
- **Clone elsewhere:** `git clone …` then `scripts/setup.ps1` or `./start.sh`

---

## Docker users cloning from GitHub

```bash
git clone https://github.com/YOUR_USERNAME/options-dashboard.git
cd options-dashboard
touch portfolio.db    # see DOCKER.md
docker compose up --build
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `remote origin already exists` | `git remote set-url origin https://github.com/YOUR_USERNAME/options-dashboard.git` |
| `Authentication failed` | Use a PAT, not your GitHub password |
| `gh not recognized` | Install GitHub CLI (Option B) or use Option A |
| Large accidental commit | Ensure `portfolio.db` and `.env` are not tracked: `git status` |

---

## What the assistant cannot do for you

Creating the GitHub repo and pushing require **your** authenticated session. No username/password should be pasted into chat — use `gh auth login` or a PAT on your machine only.
