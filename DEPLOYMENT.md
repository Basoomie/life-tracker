# Deployment Guide

Self-hosted deployment on the NAS via Docker Compose. Written for future-you after a disk failure or a clean reinstall — you should be able to follow this without looking anything else up.

---

## First-time deploy

### 1. Clone the repo

```sh
cd /mnt/user/appdata
git clone <repo-url> life-tracker
cd life-tracker
```

The repo is private. Make sure your NAS SSH key is authorized on GitHub (or wherever it's hosted).

### 2. Create the `.env` file

```sh
cp .env.example .env
nano .env          # or vi .env
```

Fill in every value:

| Variable | What to set |
|---|---|
| `APP_HOST_PORT` | High-range port (e.g. `37801`) — must not conflict with other NAS services |
| `TZ` | Your IANA timezone name (e.g. `America/Phoenix`) — the backend computes "today" (day boundaries, occurrence day, session defaults) in this timezone. Without it the container defaults to UTC, which will disagree with the frontend's local-time "today" for part of every day. |
| `POSTGRES_DB` | `tracker` (neutral name; keep it) |
| `POSTGRES_USER` | `tracker` |
| `POSTGRES_PASSWORD` | Strong random password — generate with `openssl rand -hex 32` |
| `INITIAL_USER_EMAIL` | Your email address |
| `INITIAL_USER_PASSWORD` | A temporary password you'll change after first login |
| `BACKUP_DIR` | `/mnt/user/appdata/life-tracker/backups` (or wherever your restic watches) |
| `BACKUP_SCHEDULE` | `0 3 * * *` (3am UTC daily) — adjust to your timezone offset |
| `BACKUP_KEEP_DAYS` | `14` (local retention; restic provides long-term versioned retention) |

> **Security note:** `.env` is git-ignored. Never commit it. The `${VAR:?required}` syntax in `docker-compose.yml` means Compose will fail fast with a clear error if any required variable is missing.

### 3. Create the backup directory

```sh
mkdir -p /mnt/user/appdata/life-tracker/backups
```

### 4. Build and start

```sh
docker compose build
docker compose up -d
```

This starts three containers:
- `tracker_app` — Fastify backend + built React frontend
- `tracker_db` — Postgres 16
- `tracker_backup` — pg_dump scheduler (runs on `BACKUP_SCHEDULE`, dumps to `BACKUP_DIR`)

Check that everything came up healthy:

```sh
docker compose ps
docker compose logs --tail=50 app
```

The app runs migrations on startup. Watch for `[migrate] applied:` lines in the log to confirm.

### 5. First login

Open `http://<NAS-IP>:37801` (or whatever port you set). Log in with `INITIAL_USER_EMAIL` / `INITIAL_USER_PASSWORD`.

**Change your password immediately** via the header menu → Change Password.

The `INITIAL_USER_PASSWORD` in `.env` is now only needed for break-glass recovery (see below). Keep the `.env` file safe.

---

## Upgrades (after git pull)

```sh
git pull
docker compose build
docker compose up -d
```

Migrations run automatically on startup. The Docker named volume `tracker_db_data` persists your data across rebuilds.

---

## Backups

### What gets backed up

The `tracker_backup` container runs `pg_dump` on the schedule in `BACKUP_SCHEDULE` and writes compressed files to `BACKUP_DIR`:

```
/mnt/user/appdata/life-tracker/backups/
  tracker_2026-07-08_030000.dump.gz
  tracker_2026-07-07_030000.dump.gz
  ...
```

Each file is a plain-SQL gzip dump with `--clean --if-exists` (self-contained: restore drops and recreates all tables). Files older than `BACKUP_KEEP_DAYS` are pruned automatically.

### Restic integration

Point your existing restic pipeline at the `backups/` directory. Restic provides versioned, encrypted, off-site retention on top of the local dumps. The two layers together give you:
- **Local**: fast restore from the last N days
- **Restic → B2**: long-term versioned history, off-site

### Trigger a manual backup

```sh
docker compose exec backup /usr/local/bin/do-backup
```

### Verify the last backup

```sh
ls -lh /mnt/user/appdata/life-tracker/backups/
```

A healthy backup file is typically a few hundred kilobytes. A zero-byte file means pg_dump failed — check `docker compose logs backup`.

---

## Restore procedure

**Do this after a disk failure, NAS migration, or accidental data loss.**

### Prerequisites

- Docker compose stack must be running (at minimum the `db` service).
- You have a `.dump.gz` file from `BACKUP_DIR` (or from restic).

### Steps

```sh
# 1. Stop the app to prevent writes during restore
docker compose stop app

# 2. Restore (the dump includes DROP TABLE IF EXISTS, so no manual cleanup needed)
gunzip -c /path/to/tracker_YYYY-MM-DD_HHMMSS.dump.gz \
  | docker compose exec -T db psql -U tracker tracker

# 3. Restart the app
docker compose start app
```

Or use the helper script from the project root:

```sh
bash scripts/db-restore.sh /path/to/tracker_YYYY-MM-DD_HHMMSS.dump.gz
```

### Verify the restore

Open the app and spot-check your data. The app re-runs migrations on startup — since the dump includes `schema_migrations`, `migrateUp` will apply zero new migrations (it's idempotent).

---

## Break-glass: locked out / forgot password

If you cannot log in and need to reset the password **without losing any data**:

```sh
docker compose exec app tsx src/scripts/reset-password.ts <your-email> <new-password>
```

This does an UPDATE in-place on the `users` table. The `user_id`, all items, occurrences, events, and sessions are untouched.

Alternatively, if the app container isn't running, you can set `INITIAL_USER_EMAIL` and `INITIAL_USER_PASSWORD` in `.env` and restart:

```sh
# The bootstrap() call at startup is a no-op when a user already exists.
# Use reset-password.ts, not bootstrap, for password recovery.
docker compose exec app tsx src/scripts/reset-password.ts <email> <new-password>
```

---

## PWA / HTTPS (future)

HTTPS and PWA install are explicitly deferred (see `docs/design.md` §14). When you're ready:

- **HTTPS:** put Caddy or Traefik in front of `tracker_app` as a reverse proxy. The Fastify app is already behind a single port, so HTTPS is a one-container addition with no app changes required.
- **PWA:** add a `manifest.json` and a service worker to the frontend. The app serves built static files (`apps/frontend/dist/`) which is the standard PWA target; no SSR or framework changes are needed.

Neither requires a database migration or changes to the existing stack.

---

## Container reference

| Container | Image | Role |
|---|---|---|
| `tracker_app` | custom (Dockerfile) | Fastify API + built React frontend |
| `tracker_db` | `postgres:16-alpine` | Postgres data store |
| `tracker_backup` | `postgres:16-alpine` | Scheduled pg_dump to `BACKUP_DIR` |

Named volume: `tracker_db_data` (Postgres data — persists across `docker compose down` / rebuilds).

Backup files: host-mounted directory at `BACKUP_DIR` (not a Docker volume — directly accessible to restic).
