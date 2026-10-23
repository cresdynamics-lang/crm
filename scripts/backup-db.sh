#!/usr/bin/env bash
# Nightly database backup for CRES OS.
#
#   scripts/backup-db.sh            dump the database, keep the last 14 days
#   scripts/backup-db.sh --verify   also restore the newest dump into a scratch
#                                   database and count tables (proves it restores)
#
# Reads DATABASE_URL from .env (or the environment). Writes to BACKUP_DIR
# (default: ~/cres-backups), one compressed custom-format file per run.
#
# On the server, run nightly with cron, e.g.:
#   15 2 * * * cd /path/to/crm && scripts/backup-db.sh --verify >> ~/cres-backups/backup.log 2>&1
# Copy the folder off the server too (DigitalOcean Spaces, or rsync to another
# machine): a backup on the same disk does not survive losing that disk.
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'")"
fi
: "${DATABASE_URL:?DATABASE_URL is not set}"

# Find the Postgres tools (PATH first, then Homebrew).
for dir in "" /opt/homebrew/opt/postgresql@18/bin /opt/homebrew/opt/postgresql@17/bin /usr/lib/postgresql/*/bin; do
  if [[ -z "$dir" ]] && command -v pg_dump >/dev/null; then PG_BIN="$(dirname "$(command -v pg_dump)")"; break; fi
  if [[ -n "$dir" && -x "$dir/pg_dump" ]]; then PG_BIN="$dir"; break; fi
done
: "${PG_BIN:?pg_dump not found - install the PostgreSQL client tools}"

BACKUP_DIR="${BACKUP_DIR:-$HOME/cres-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date +%Y%m%d-%H%M%S)"
file="$BACKUP_DIR/cres-os-$stamp.dump"
"$PG_BIN/pg_dump" --format=custom --no-owner --no-privileges --file="$file" "$DATABASE_URL"
chmod 600 "$file"
size="$(du -h "$file" | cut -f1)"
echo "[backup] $(date -u +%FT%TZ) wrote $file ($size)"

# Retention
find "$BACKUP_DIR" -name 'cres-os-*.dump' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[backup] removed old /'

if [[ "${1:-}" == "--verify" ]]; then
  base="${DATABASE_URL%/*}"
  scratch="cres_restore_check_$$"
  "$PG_BIN/psql" "$base/postgres" -qc "CREATE DATABASE $scratch" >/dev/null
  trap '"$PG_BIN/psql" "$base/postgres" -qc "DROP DATABASE IF EXISTS $scratch" >/dev/null' EXIT
  "$PG_BIN/pg_restore" --no-owner --no-privileges --dbname="$base/$scratch" "$file"
  tables="$("$PG_BIN/psql" "$base/$scratch" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  users="$("$PG_BIN/psql" "$base/$scratch" -tAc "SELECT count(*) FROM users")"
  echo "[backup] verified: restored $tables tables, $users users into a scratch database (removed)"
fi
