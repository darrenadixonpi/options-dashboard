# Docker deployment guide

Run the Options Dashboard in a container when you prefer not to install Python locally, or when you want a reproducible, isolated runtime.

---

## Prerequisites

Install **Docker** and ensure the daemon is running:

| Platform | Install |
|----------|---------|
| **Windows / macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| **Linux** | [Docker Engine](https://docs.docker.com/engine/install/) + [Compose plugin](https://docs.docker.com/compose/install/) |

Verify:

```bash
docker --version
docker compose version
```

You need the project folder on your machine (clone or copy the repo). All commands below are run from the **project root** (where `docker-compose.yml` lives).

---

## Quick start

### 1. Prepare the database file (important)

Compose bind-mounts `./portfolio.db` so snapshots and session data survive container restarts. On first run, create an empty file **before** starting Docker — otherwise Docker may create a **directory** named `portfolio.db`, which breaks SQLite.

**macOS / Linux:**

```bash
touch portfolio.db
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType File -Path portfolio.db -Force
```

### 2. Build and start

```bash
docker compose up --build
```

First build takes a few minutes (Node builds the frontend bundle, then Python image). When you see the server banner, open:

**http://localhost:5000**

Stop with `Ctrl+C`. To run in the background:

```bash
docker compose up --build -d
```

### 3. Stop / remove

```bash
docker compose down          # stop containers
docker compose down -v       # stop + remove named volumes (if any added later)
```

---

## What the container includes

The `Dockerfile` uses a **multi-stage build**:

1. **Node stage** — runs `npm run build` → minified `static/dist/app.bundle.js`
2. **Python stage** — Flask app on port 5000 with `USE_JS_BUNDLE=1` (single JS bundle, no dev script tags)

Runtime settings (set in `docker-compose.yml` / `Dockerfile`):

| Setting | Value in Docker |
|---------|-----------------|
| `HOST` | `0.0.0.0` (listen on all interfaces inside the container) |
| `PORT` | `5000` (default; overridable) |
| `FLASK_DEBUG` | `0` |
| `USE_JS_BUNDLE` | `1` |

The app is started via `scripts/launch.py --host 0.0.0.0 --no-browser` (no auto-open browser inside the container).

---

## Data persistence

| Path (host) | Path (container) | Purpose |
|-------------|------------------|---------|
| `./portfolio.db` | `/app/portfolio.db` | SQLite — fetch snapshots, book MTM, alert log, sessions |

**Backup:** copy `portfolio.db` while the container is stopped, or use `docker compose stop` first for a clean copy.

**Reset:** delete `portfolio.db` and recreate an empty file with `touch portfolio.db` (or `New-Item` on Windows), then `docker compose up` again.

Portfolio CSVs and session state in the browser still live in **browser localStorage** unless you use the app’s session restore — the DB stores server-side snapshots from fetches, not your uploaded CSV files.

---

## Custom port

Default host port is **5000**. To use another port (e.g. 8080):

**Option A — `.env` file** in the project root:

```env
PORT=8080
```

**Option B — one-off:**

```bash
PORT=8080 docker compose up --build
```

Then open **http://localhost:8080**.

Compose maps `${PORT}` on the host to the same port inside the container and passes `PORT` to the app.

---

## Everyday commands

| Task | Command |
|------|---------|
| Start (foreground) | `docker compose up` |
| Start (background) | `docker compose up -d` |
| Rebuild after code changes | `docker compose up --build` |
| View logs | `docker compose logs -f` |
| Check status | `docker compose ps` |
| Restart | `docker compose restart` |
| Shell inside container | `docker compose exec options-dashboard bash` |

After pulling or editing code, rebuild so the image picks up changes:

```bash
docker compose build --no-cache
docker compose up -d
```

---

## Updating the app

1. Pull or copy new project files.
2. Rebuild and restart:

   ```bash
   docker compose up --build -d
   ```

3. Hard-refresh the browser (`Ctrl+Shift+R`) so the new JS bundle loads.

Your `portfolio.db` on the host is unchanged unless you deleted it.

---

## Troubleshooting

### Port already in use

```text
Bind for 0.0.0.0:5000 failed: port is already allocated
```

Another process (or a local `python app.py`) is using the port. Either stop it, or set `PORT=8080` in `.env` and use http://localhost:8080.

### `portfolio.db` is a directory

Symptoms: SQLite errors on startup, or “unable to open database file”.

Fix:

```bash
docker compose down
rm -rf portfolio.db          # Linux/macOS — only if it's a directory!
# Windows: Remove-Item -Recurse -Force portfolio.db
touch portfolio.db             # or New-Item -ItemType File portfolio.db
docker compose up -d
```

### Container unhealthy / page won't load

```bash
docker compose logs options-dashboard
docker compose ps
```

Wait for the healthcheck `start_period` (~15s) on first boot. If logs show import or pip errors, rebuild:

```bash
docker compose build --no-cache
docker compose up -d
```

### Blank page or old UI after update

The image bakes in `static/dist/app.bundle.js` at build time. Rebuild the image (`docker compose up --build`). Then hard-refresh the browser.

### Docker Desktop on Windows

- Enable WSL 2 backend if prompted.
- Share the drive where the project lives (Settings → Resources → File sharing).
- Run `docker compose` from PowerShell or WSL in the project directory.

### Cannot reach from another device on your LAN

By default you only access via `localhost`. To reach from another machine on the same network, Docker Desktop usually publishes `0.0.0.0:5000` already — try `http://<your-pc-ip>:5000`. Ensure firewall allows inbound TCP on that port. **Do not expose this to the public internet** without authentication and HTTPS; the app is designed for local desk use.

---

## Without Compose (optional)

Equivalent manual flow:

```bash
docker build -t options-dashboard .
docker run --rm -p 5000:5000 \
  -v "$(pwd)/portfolio.db:/app/portfolio.db" \
  -e HOST=0.0.0.0 \
  -e PORT=5000 \
  -e FLASK_DEBUG=0 \
  -e USE_JS_BUNDLE=1 \
  options-dashboard
```

On Windows PowerShell, use `${PWD}/portfolio.db` instead of `$(pwd)/portfolio.db`.

---

## Docker vs local Python

| | **Docker** | **Local (`start.bat` / `start.sh`)** |
|---|------------|--------------------------------------|
| Python install | Not required | Required (3.10+) |
| Frontend | Pre-built bundle in image | Individual JS files (faster to edit) |
| Best for | Deploy, share, consistent env | Day-to-day development |
| Data | `portfolio.db` bind mount | `portfolio.db` in project root |

For daily development, use `start.bat` or `./start.sh`. Use Docker when you want a one-command runtime without touching the host Python environment.

---

## Related files

- `Dockerfile` — multi-stage build definition
- `docker-compose.yml` — ports, env, volume, healthcheck
- `.dockerignore` — keeps image smaller
- `.env.example` — template for `PORT` and other overrides (copy to `.env`)

See also [README.md](README.md) for general usage, [CHANGELOG.md](CHANGELOG.md) for release notes, and [static/js/README.md](static/js/README.md) for frontend bundle details.
