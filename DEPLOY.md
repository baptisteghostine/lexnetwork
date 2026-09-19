# Deploying Rolo

Rolo is a single-container, single-user app. The only state is the `data/`
directory (SQLite database, attachments, backups) — everything else is
rebuildable from this repository.

## VPS quick start

```bash
git clone <this repo> rolo && cd rolo
docker compose up -d --build
```

First boot applies all database migrations automatically, then serves on
port 3000 (`ROLO_PORT` in the environment or a `.env` file changes the host
port). Open the app and the first-run screen asks you to create the
password.

### Behind a reverse proxy (recommended)

Terminate TLS at Caddy/nginx/Traefik and proxy to `127.0.0.1:3000`. Then
tell Rolo its public host, or Next.js rejects every Server Action as a
CSRF mismatch:

```bash
# .env next to docker-compose.yml
ROLO_ALLOWED_ORIGINS=rolo.example.com
```

Caddy example (automatic TLS):

```
rolo.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

When the app is reached over HTTPS, the session cookie is set with the
`Secure` flag automatically (detected via `X-Forwarded-Proto`, which every
mainstream proxy sends).

### Environment variables

| Variable | Purpose |
|---|---|
| `ROLO_ALLOWED_ORIGINS` | Comma-separated `host[:port]` allowed for Server Actions behind a proxy. `*.example.com` wildcards work. |
| `SESSION_SECRET` | Optional fixed secret for session cookies and the token box. Unset → a generated secret persists in `data/secret.key`. Rotating it logs you out and invalidates stored OAuth tokens ("reconnect" in Settings). |
| `GROQ_API_KEY`, `GROQ_MODEL` | Optional; both set → AI features appear via Groq's free tier (key from console.groq.com; model e.g. `openai/gpt-oss-120b`). |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional; the Anthropic alternative. When both providers are configured, `AI_PROVIDER=groq\|anthropic` picks (default groq). |
| `ROLO_PORT` | Host port for docker compose (default 3000). |

## Windows (Docker Desktop)

Rolo runs fine on a Windows laptop under Docker Desktop, with one change:
keep `data/` on a **named Docker volume**, not the default `./data` bind
mount. SQLite in WAL mode depends on file locking that Docker Desktop's
Windows file sharing does not honour, and a bind-mounted database was
corrupted that way once (2026-09-08; see "Corrupt database" below).

One-time setup, in PowerShell from the checkout:

```powershell
docker compose stop
Copy-Item docker-compose.windows.yml docker-compose.override.yml   # gitignored; merged automatically
# copy the existing data into the new volume (skip on a fresh install)
docker compose run --rm --no-deps -v ${PWD}\data:/from --entrypoint sh rolo -c "cp -a /from/. /app/data/"
docker compose up -d --build
```

After that `docker compose` commands work as before. The data now lives in
the `lexnetwork_rolo-data` volume rather than the folder, so to get at
backups or the database file use the container:

```powershell
docker compose cp rolo:/app/data/backups .\backups-copy      # pull the nightly backups out
docker compose cp .\rolo-YYYYMMDD-HHMMSS.db rolo:/app/data/rolo.db   # restore one (container stopped first)
```

## Backups & restore

A nightly job runs SQLite `VACUUM INTO data/backups/rolo-<timestamp>.db`
and prunes backups older than 30 days. Status (and a "Back up now" button)
is in **Settings → Data**; a failed backup shows a red banner in the app.

Copy `data/backups/` somewhere off the machine on your own schedule —
`rsync`/restic/whatever you already use. Each file is a complete,
standalone database.

**Restore** (also the "restore into a scratch container" drill):

```bash
docker compose down
cp data/backups/rolo-YYYYMMDD-HHMMSS.db data/rolo.db
rm -f data/rolo.db-wal data/rolo.db-shm
docker compose up -d
```

Attachments are files under `data/attachments/` and are not inside the
database — back that directory up alongside `data/backups/`.

**Corrupt database** (`SqliteError: database disk image is malformed` in
the logs, Today crashing while other pages work, every new backup 0 bytes).
Before restoring an old backup, try rebuilding the live file: when the
tables still read, `scripts/rebuild-sqlite.mjs` copies every row into a
fresh database, rebuilds the search indexes, and only reports "clean" when
row counts and `integrity_check` agree. It runs inside the production
image, so nothing needs installing:

```bash
docker compose stop
cp -r data data-corrupt-$(date +%F)          # keep the damaged original
cp scripts/rebuild-sqlite.mjs data/rebuild.mjs
docker compose run --rm --no-deps --entrypoint node rolo /app/data/rebuild.mjs
# only if the last line is "RESULT: clean rebuild":
rm -f data/rolo.db data/rolo.db-wal data/rolo.db-shm data/rebuild.mjs
mv data/rolo-rebuilt.db data/rolo.db
docker compose up -d
```

On the Windows named-volume setup the same drill runs through the
container: `docker compose cp scripts/rebuild-sqlite.mjs rolo:/app/data/rebuild.mjs`
to put the script in place, `docker compose cp rolo:/app/data ./data-corrupt`
for the safety copy, and `docker compose run --rm --no-deps --entrypoint sh rolo`
for the `rm`/`mv` steps.

If the rebuild reports a failing table, fall back to the newest good
backup above. Seen once on Windows, where SQLite's WAL locking on a
Docker Desktop bind mount is the usual culprit; the named-volume setup
under "Windows (Docker Desktop)" above avoids it.

There is also the one-click **full export** (Settings → Data): a ZIP with
a flattened `contacts.csv`, per-table JSON, and all attachments.

## Forgot the password

The reset script only needs Node and the data directory — run it from a
checkout on the VPS (container can stay up; the change is immediate):

```bash
npm install --ignore-scripts
ROLO_DATA_DIR=./data npm run reset-password -- <newpassword>
```

## Updating

```bash
git pull
docker compose up -d --build
```

Migrations are append-only and apply automatically on boot.
