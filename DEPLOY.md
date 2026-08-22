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
| `SESSION_SECRET` | Optional fixed secret for session cookies and the token box. Unset → a generated secret persists in `data/secret.key`. Rotating it logs you out and invalidates stored OAuth/Voyager tokens ("reconnect" in Settings). |
| `GROQ_API_KEY`, `GROQ_MODEL` | Optional; both set → AI features appear via Groq's free tier (key from console.groq.com; model e.g. `openai/gpt-oss-120b`). |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional; the Anthropic alternative. When both providers are configured, `AI_PROVIDER=groq\|anthropic` picks (default groq). |
| `ROLO_PORT` | Host port for docker compose (default 3000). |

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
