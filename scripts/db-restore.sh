#!/bin/sh
# Restore the tracker database from a gzipped pg_dump file.
#
# Usage (run from the project root, with the Docker compose stack running):
#   bash scripts/db-restore.sh <backup.dump.gz>
#
# Example:
#   bash scripts/db-restore.sh /mnt/user/appdata/life-tracker/backups/tracker_2026-07-01_030000.dump.gz
#
# What this does:
#   1. Stops the app container to prevent writes during restore.
#   2. Pipes the decompressed dump through psql.
#      The dump's --clean --if-exists flags mean it drops all existing tables
#      before recreating them -- no manual DROP is required.
#   3. Restarts the app.
#
# Requirements:
#   - Docker compose stack must be accessible from this directory.
#   - A .env file (or env vars POSTGRES_USER and POSTGRES_DB) must be present.
#   - The dump file must be a .gz produced by the backup service (pg_dump plain format).
#
# Break-glass password recovery (if you also lost the password):
#   After restore, run:
#     docker compose exec app tsx src/scripts/reset-password.ts <email> <new-password>
#   This resets the password in-place; all data is preserved.

set -e

DUMP_FILE="$1"

if [ -z "$DUMP_FILE" ]; then
  echo "Usage: bash scripts/db-restore.sh <backup.dump.gz>" >&2
  exit 1
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "Error: file not found: $DUMP_FILE" >&2
  exit 1
fi

# Load POSTGRES_USER and POSTGRES_DB from .env if present.
# shellcheck disable=SC1091
if [ -f ".env" ]; then
  . "./.env"
fi

POSTGRES_USER="${POSTGRES_USER:-tracker}"
POSTGRES_DB="${POSTGRES_DB:-tracker}"

echo "[restore] ============================================================"
echo "[restore] Source : $DUMP_FILE"
echo "[restore] Target : ${POSTGRES_DB} @ tracker_db"
echo "[restore] ============================================================"
echo ""
echo "[restore] Stopping app container (prevents writes during restore)..."
docker compose stop app

echo "[restore] Restoring database..."
gunzip -c "$DUMP_FILE" | docker compose exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"

echo ""
echo "[restore] Restarting app container..."
docker compose start app

echo ""
echo "[restore] Done. Database restored from: $DUMP_FILE"
echo ""
echo "Verify by opening the app and checking your data."
echo "If the data looks wrong, restore an older backup."
echo ""
echo "If you were also locked out, reset the password now:"
echo "  docker compose exec app tsx src/scripts/reset-password.ts <email> <new-password>"
