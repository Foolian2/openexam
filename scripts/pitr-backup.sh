#!/usr/bin/env bash
# Daily wal-g base backup, on top of continuous WAL archiving (postgres
# service's archive_command in docker-compose.prod.yml). Together these give
# point-in-time recovery — see DEPLOYMENT.md's "Point-in-time recovery" and
# scripts/pitr-restore.sh. Installed by scripts/setup-monitoring.sh as its
# own cron line, independent of scripts/install-cron.sh's pg_dump line:
#   0 4 * * * /opt/openexam/scripts/pitr-backup.sh >> /var/log/openexam-pitr-backup.log 2>&1
#
# Enabled only when WALG_STORAGE_BACKEND=sftp is configured.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/production-compose.sh
source scripts/lib/pitr-state.sh

if [ "$walg_backend" = disabled ]; then
  echo "DISABLED: PITR backups are disabled; daily pg_dump continues."
  exit 0
fi

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (copy .env.example)"; exit 1; }
require_walg_secrets

# `$PGDATA` must expand INSIDE the container (the postgres image's
# entrypoint exports it, default /var/lib/postgresql/data) — routing through
# `sh -c` here, not a bare `exec ... wal-g backup-push "$PGDATA"`, which
# would instead expand this script's own (unset) PGDATA on the host.
# `-u postgres` + PGUSER: wal-g connects to the server for metadata, and the
# OS user inside the container (root by default) has no matching DB role —
# the server's only login role is `openexam`.
"${COMPOSE[@]}" exec -T -u postgres postgres sh -c 'PGUSER=openexam wal-g backup-push "$PGDATA"'

# Retention: keep the last 7 full backups (wal-g prunes backups AND the WAL
# segments no longer needed by any retained backup). --confirm actually
# deletes; without it this would only print what would be deleted.
"${COMPOSE[@]}" exec -T -u postgres postgres wal-g delete retain FULL 7 --confirm

# Confirm that the archive can be listed before reporting success.
"${COMPOSE[@]}" exec -T -u postgres postgres wal-g backup-list >/dev/null

# node-exporter textfile-collector metric — see scripts/backup.sh for the
# same pattern (atomic write, world-readable, monitoring-only).
metrics_dir="./monitoring-data/textfile-collector"
if [ -d "$metrics_dir" ]; then
  metrics_tmp="$(mktemp "$metrics_dir/.wal_g_backup.XXXXXX")"
  {
    echo "# HELP openexam_backup_last_success_timestamp_seconds Unix timestamp of the last successful backup"
    echo "# TYPE openexam_backup_last_success_timestamp_seconds gauge"
    echo "openexam_backup_last_success_timestamp_seconds{job=\"wal_g\"} $(date +%s)"
  } > "$metrics_tmp"
  chmod 644 "$metrics_tmp"
  mv "$metrics_tmp" "$metrics_dir/wal_g_backup.prom"
fi

echo "OK: wal-g base backup pushed and retention applied"
