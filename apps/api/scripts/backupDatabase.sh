#!/usr/bin/env bash
# Takes a pg_dump backup of the database named by BACKUP_DATABASE_URL (use the Supabase SESSION POOLER string). Read-only: it only reads data.
#
#   BACKUP_DATABASE_URL='<session pooler string>' bash apps/api/scripts/backupDatabase.sh /path/to/private/backup/folder
#
# Safety rules built in: the output folder must be OUTSIDE the git repository (a dump holds personal data and must never be committed), the connection
# string is never printed, and nothing is written to the database. See docs/BACKUP_AND_RECOVERY.md.
set -euo pipefail

if [ -z "${BACKUP_DATABASE_URL:-}" ]; then echo "Set BACKUP_DATABASE_URL (Supabase session pooler string) for this command." >&2; exit 2; fi
if [ $# -ne 1 ]; then echo "Usage: backupDatabase.sh <output folder outside the repository>" >&2; exit 2; fi
if ! command -v pg_dump >/dev/null 2>&1; then echo "pg_dump is not installed (install PostgreSQL client tools, version 17 or newer)." >&2; exit 2; fi

OUT="$(cd "$1" 2>/dev/null && pwd)" || { echo "Output folder does not exist." >&2; exit 2; }
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent-path)" 2>/dev/null && pwd || true)"  # normalised the same way as $OUT (matters on Windows Git Bash)
if [ -n "$REPO" ]; then
  case "$OUT/" in "$REPO"/*) echo "Refusing: the output folder is inside the git repository. Choose a private folder elsewhere." >&2; exit 3;; esac
fi

FILE="$OUT/platino-$(date +%F-%H%M).dump"
export PGSSLMODE=require
echo "Backing up to $FILE (connection string not shown)..."
pg_dump "$BACKUP_DATABASE_URL" --format=custom --no-owner --no-privileges --file="$FILE"
chmod 600 "$FILE" 2>/dev/null || true
echo "Done: $(wc -c < "$FILE") bytes. Test it with pg_restore against a THROWAWAY database (docs/BACKUP_AND_RECOVERY.md section 4)."
