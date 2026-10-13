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

source scripts/lib/production-compose.sh

usage() {
  cat <<'EOF'
Usage:
  scripts/pitr-restore.sh --latest --yes-i-am-sure
  scripts/pitr-restore.sh --target-time "2026-08-13 12:00:00+00" --yes-i-am-sure

--latest         Restore the most recent base backup with no WAL replay past it.
--target-time T  Restore to the state as of T (any format Postgres's
                  recovery_target_time accepts) — a base backup at or before
                  T is fetched, then archived WAL is replayed up to T.
--yes-i-am-sure  Required. This overwrites postgres_data's current contents.
EOF
}

target_time=""
latest=false
confirmed=false
while [ $# -gt 0 ]; do
  case "$1" in
    --target-time) target_time="${2:-}"; shift 2 ;;
    --latest) latest=true; shift ;;
    --yes-i-am-sure) confirmed=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$target_time" ] && [ "$latest" = false ]; then
  echo "ERROR: --target-time or --latest is required" >&2
  usage
  exit 1
fi
if [ -n "$target_time" ] && [ "$latest" = true ]; then
  echo "ERROR: --target-time and --latest are mutually exclusive" >&2
  exit 1
fi
if [ "$confirmed" != true ]; then
  echo "ERROR: this OVERWRITES the live postgres_data volume." >&2
  echo "Re-run with --yes-i-am-sure once you've confirmed this is what you want (see DEPLOYMENT.md)." >&2
  exit 1
fi

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (copy .env.example)"; exit 1; }

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

echo "Stopping app tier and postgres..."
"${COMPOSE[@]}" stop web ws-backend postgres

echo "Fetching base backup and configuring recovery (existing postgres_data contents are replaced)..."
# RESTORE_TARGET_TIME travels as an env var into the container (docker
# compose's `-e VAR` without a value forwards this process's own env), not
# interpolated into the shell string below — target_time is operator-
# supplied text and could otherwise break the embedded script's quoting.
RESTORE_TARGET_TIME="$target_time" "${COMPOSE[@]}" run --rm --no-deps \
  --entrypoint sh -e RESTORE_TARGET_TIME postgres -c '
    set -e
    rm -rf "${PGDATA:?}"/*
    wal-g backup-fetch "$PGDATA" LATEST
    touch "$PGDATA/recovery.signal"
    {
      echo "restore_command = '"'"'wal-g wal-fetch %f %p'"'"'"
      if [ -n "$RESTORE_TARGET_TIME" ]; then
        echo "recovery_target_time = '"'"'$RESTORE_TARGET_TIME'"'"'"
        echo "recovery_target_action = '"'"'promote'"'"'"
      else
        # --latest: stop at the first consistent state. Without an explicit
        # target, Postgres would replay every archived WAL segment until
        # wal-fetch fails — not the "no WAL replay" this flag promises.
        echo "recovery_target = '"'"'immediate'"'"'"
        echo "recovery_target_action = '"'"'promote'"'"'"
      fi
    } >> "$PGDATA/postgresql.auto.conf"
  '

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
