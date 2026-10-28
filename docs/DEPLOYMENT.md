# Production deployment

This is a **personal, single-user** tool that stores your CV and personal data. Deploy it accordingly: one instance per
person, behind HTTPS, with a password.

## Hard requirements

1. `APP_PASSWORD` set. If `HOST` is not loopback and no password is set, **the app refuses to start**.
2. HTTPS in front (basic-auth credentials are readable over plain HTTP).
3. A Supabase project (`DATABASE_URL`) and a persistent `DATA_DIR` (uploaded files) that you **back up**.
4. `APP_SECRET` if you want email notifications.
5. Exactly one instance with `SCHEDULER` on (two would run duplicate searches).

**Settings → Production readiness** shows these checks live; fix every ✕ before exposing the app.

## Without Docker (systemd + Caddy)

```bash
git clone <repo> /opt/jobfinder && cd /opt/jobfinder
npm ci --omit=dev
cp .env.example .env                    # set HOST=127.0.0.1 (Caddy proxies locally), APP_PASSWORD, APP_SECRET, TRUST_PROXY=1, DATA_DIR=/var/lib/jobfinder
```

`/etc/systemd/system/jobfinder.service`:

```ini
[Unit]
Description=Saudi Job Finder
After=network.target
[Service]
WorkingDirectory=/opt/jobfinder
EnvironmentFile=/opt/jobfinder/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
User=jobfinder
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
```

`Caddyfile` (automatic HTTPS):

```
jobs.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `TRUST_PROXY=1` so the login lockout sees real client IPs.

## Docker

```bash
cp .env.example .env          # must define APP_PASSWORD (+ APP_SECRET)
docker compose up -d --build
```

`docker-compose.yml` publishes the port to `127.0.0.1` only, stores data in the `jobfinder-data` volume and includes a health
check on `/healthz`. Put a TLS reverse proxy in front for remote access. Browser-assisted apply (Mode B) cannot work in a
container: it opens a visible Chrome window on your own computer.

**Verified:** the image builds; it refuses to start on a network address without `APP_PASSWORD`; runs as a non-root user;
enforces the password; reports `healthy`; applies migrations; and keeps its data across a container restart.

**AI gateway on the same machine (e.g. OmniRoute):** gateways usually listen on `127.0.0.1` only, which a normal (bridged)
container cannot reach, not even through `host.docker.internal`. Use `docker compose -f docker-compose.host.yml up -d --build`
instead: it runs the app on the host network (Linux), still loopback-only, so `AI_BASE_URL=http://127.0.0.1:20128/v1` works.
This was verified against a running OmniRoute. If the gateway is remote, use the default compose file and an `https://` URL.

Hosts with ephemeral disks (many free PaaS tiers) lose the database on restart. Use a persistent volume.

## Backups and upgrades

- Back up `DATA_DIR/uploads/`. The database is in Supabase: use its dashboard backups, or `pg_dump "$DATABASE_URL"`.
- Upgrade: stop, back up, update the code, `npm ci --omit=dev`, start. Migrations apply automatically (`npm run migrate`
  prints status). They are forward-only: restore a backup to go back.
- Restore: stop, put the database and `uploads/` back, start.

## Operations

- Liveness: `GET /healthz` (no auth, no data). Everything else needs credentials.
- Status: **Settings → Integration status** (job sources, AI, email, scheduler, browser assist, database) and the activity log.
- Logs go to stdout; unexpected errors are logged server-side only. Responses never include internals.
- Deleting everything: **Settings → Privacy → Delete all my data** (or delete `DATA_DIR`).
