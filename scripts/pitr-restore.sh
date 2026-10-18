#!/usr/bin/env bash
# Point-in-time restore from wal-g base backups + archived WAL (see
# scripts/pitr-backup.sh and docker-compose.prod.yml's postgres
# archive_command). Full runbook: DEPLOYMENT.md's "Point-in-time recovery".
#
# DESTRUCTIVE — unlike every other script in scripts/, this is NOT
# idempotent/safe-to-re-run: it wipes postgres_data's current contents
# before restoring. Requires an explicit --yes-i-am-sure flag rather than
# just running when invoked, on purpose. For a practice/verification run,
# see DEPLOYMENT.md's drill procedure, which points this at a throwaway
# volume instead of the live one — never rehearse against production.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Usage:
  scripts/pitr-restore.sh --latest --yes-i-am-sure

--latest         Restore the most recent base backup with no WAL replay past it.
Historical --target-time restores are disabled until recovery can be
validated in a scratch volume before replacing the live data directory.
--yes-i-am-sure  Required. This overwrites postgres_data's current contents.
EOF
}

latest=false
confirmed=false
while [ $# -gt 0 ]; do
  case "$1" in
    --target-time | --target-time=*)
      echo "ERROR: Historical --target-time restore is disabled; validate recovery in a scratch volume first." >&2
      echo "No services were stopped and no database files were changed." >&2
      exit 1 ;;
    --latest) latest=true; shift ;;
    --yes-i-am-sure) confirmed=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [ "$latest" = false ]; then
  echo "ERROR: --latest is required (historical --target-time restores are disabled)" >&2
  usage
  exit 1
fi
if [ "$confirmed" != true ]; then
  echo "ERROR: this OVERWRITES the live postgres_data volume." >&2
  echo "Re-run with --yes-i-am-sure once you've confirmed this is what you want (see DEPLOYMENT.md)." >&2
  exit 1
fi

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (copy .env.example)"; exit 1; }

# Sourced only after argument validation: every refusal above (historical
# targets, missing confirmation) must happen without touching compose or
# Docker, and before this script reads .env.prod.
source scripts/lib/production-compose.sh

if [ "$walg_backend" = disabled ]; then
  echo "ERROR: PITR is disabled; configure SFTP before restoring." >&2
  exit 1
fi
require_walg_secrets

# The archive is reachable only through the walg-sftp tunnel, and the
# `run --no-deps` below does not start it. Bring it up and require a working
# end-to-end SSH path (its healthcheck) before anything is stopped or wiped.
echo "Starting the backup tunnel..."
if ! "${COMPOSE[@]}" up -d --wait --wait-timeout 90 walg-sftp; then
  echo "ERROR: the walg-sftp tunnel did not become healthy; nothing was changed." >&2
  echo "  Check: $COMPOSE_CMD logs walg-sftp" >&2
  exit 1
fi

# Preflight while everything is still running: the archive must be reachable
# and hold a base backup, or the wipe below would leave nothing to restore.
echo "Checking the archive..."
if ! "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh postgres -c '
    backups=$(wal-g backup-list 2>&1) || { printf "%s\n" "$backups" >&2; exit 1; }
    printf "%s\n" "$backups" | grep -q base_ || { printf "%s\n" "$backups" >&2; exit 1; }
  '; then
  echo "ERROR: no base backup could be listed from the archive; nothing was changed." >&2
  exit 1
fi

# Safety dump before anything is stopped or replaced. The base backup we are
# about to fetch is only as fresh as the last wal-g push, so this dump is the
# sole copy of everything committed since then — and the only rollback if the
# fetched backup turns out to be unusable. Same naming and permissions as
# scripts/backup.sh (seconds in the name so the two cannot collide).
BACKUP_DIR="${BACKUP_DIR:-./backups}"
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
safety="$BACKUP_DIR/openexam-$(date +%F-%H%M%S).dump"
if [ -e "$safety" ]; then
  echo "ERROR: $safety already exists; refusing to overwrite a dump." >&2
  exit 1
fi
echo "Taking a safety dump..."
if ! "${COMPOSE[@]}" exec -T postgres pg_dump -U openexam -Fc openexam > "$safety"; then
  echo "ERROR: safety dump failed; nothing was changed." >&2
  rm -f "$safety"
  exit 1
fi
if [ ! -s "$safety" ]; then
  echo "ERROR: empty safety dump $safety; nothing was changed." >&2
  rm -f "$safety"
  exit 1
fi
echo "Safety dump: $safety ($(du -h "$safety" | cut -f1))"

echo "Stopping app tier and postgres..."
"${COMPOSE[@]}" stop web ws-backend postgres

echo "Fetching base backup and configuring recovery (existing postgres_data contents are replaced)..."
# The container program is piped in with `sh -s` and assembled from
# scripts/lib/restore-in-container.sh plus scripts/lib/recovery-conf.sh, in
# that order. Both are plain scripts the restore drill runs directly, so
# neither half can silently drift away from what the tests cover.
{
  cat scripts/lib/restore-in-container.sh
  cat scripts/lib/recovery-conf.sh
} | "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh postgres -s

echo "Starting postgres in recovery mode..."
"${COMPOSE[@]}" up -d postgres

echo "Waiting for recovery to complete and postgres to promote (this can take a while depending on how much WAL needs replaying)..."
for _ in $(seq 1 120); do
  if "${COMPOSE[@]}" exec -T postgres pg_isready -U openexam >/dev/null 2>&1; then
    in_recovery="$("${COMPOSE[@]}" exec -T postgres psql -U openexam -tAc 'SELECT pg_is_in_recovery();' 2>/dev/null || echo "")"
    if [ "$in_recovery" = "f" ]; then
      echo "OK: postgres has promoted out of recovery."
      echo "Restart the app tier when ready: $COMPOSE_CMD up -d web ws-backend"
      exit 0
    fi
  fi
  sleep 5
done

echo "WARNING: postgres did not confirm promotion within 10 minutes — check its logs:" >&2
echo "  $COMPOSE_CMD logs postgres" >&2
exit 1
