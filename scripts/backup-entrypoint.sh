#!/bin/sh
# Backup container entrypoint.
# Runs pg_dump on BACKUP_SCHEDULE (cron) and gzips the output to /backups.
# Files older than BACKUP_KEEP_DAYS days are pruned after each run.
# Runs an initial backup immediately on startup.
#
# Environment (set via docker-compose):
#   PGHOST, PGDATABASE, PGUSER, PGPASSWORD — Postgres connection
#   BACKUP_SCHEDULE  — cron expression (default: "0 3 * * *", daily 3am UTC)
#   BACKUP_KEEP_DAYS — retention days  (default: 14)

set -e

BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BACKUP_CRON="${BACKUP_SCHEDULE:-0 3 * * *}"

mkdir -p /backups

# Write connection env to a file; busybox crond does NOT inherit the process environment.
cat > /tmp/backup.env << ENV
export PGHOST="${PGHOST}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER}"
export PGPASSWORD="${PGPASSWORD}"
export PGDATABASE="${PGDATABASE}"
export BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS}"
ENV
chmod 600 /tmp/backup.env

# Write the backup script that crond will invoke.
cat > /usr/local/bin/do-backup << 'SCRIPT'
#!/bin/sh
# shellcheck source=/dev/null
. /tmp/backup.env
ts=$(date -u +%Y-%m-%d_%H%M%S)
filename="/backups/tracker_${ts}.dump.gz"
echo "[backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting -> $filename"
pg_dump \
  --host="$PGHOST" \
  --port="${PGPORT:-5432}" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --format=plain \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  | gzip -9 > "$filename"
size=$(du -h "$filename" | cut -f1)
echo "[backup] done -- ${size} written to $filename"
find /backups -name "tracker_*.dump.gz" -mtime "+${BACKUP_KEEP_DAYS}" -delete
echo "[backup] pruned files older than ${BACKUP_KEEP_DAYS} days"
SCRIPT
chmod +x /usr/local/bin/do-backup

# Install the cron job; redirect stdout/stderr to PID 1's fd so logs appear in
# `docker compose logs backup`.
echo "${BACKUP_CRON} /usr/local/bin/do-backup >> /proc/1/fd/1 2>&1" | crontab -

echo "[backup] service ready -- schedule: ${BACKUP_CRON}, retain: ${BACKUP_KEEP_DAYS} days"
echo "[backup] running initial backup on startup..."
/usr/local/bin/do-backup

# Run crond in the foreground (-f).
exec crond -f -d 8
