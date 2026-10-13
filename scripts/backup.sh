#!/usr/bin/env bash
# Daily PostgreSQL backup (PRD §12.3 / §15.2). Run from host cron, e.g.:
#   0 3 * * * /opt/openexam/scripts/backup.sh >> /var/log/openexam-backup.log 2>&1
# Keeps 14 days locally. NOTE: this is daily-RPO pg_dump, not <1h PITR — see
# scripts/pitr-backup.sh (WAL archiving via wal-g) for that, installed
# separately by scripts/setup-monitoring.sh. Copy dumps offsite regardless.
set -euo pipefail
# Dumps contain the full student DB (PII, password hashes, session tokens,
# exam content). The shell-redirection default umask (022) would create
# world-readable files on a multi-user host; force 0700 dirs / 0600 files.
umask 077
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Seconds in the name: two dumps in the same minute (./openexam restore takes
# a safety dump right before restoring) must not overwrite each other.
out="$BACKUP_DIR/openexam-$(date +%F-%H%M%S).dump"
[ ! -e "$out" ] || { echo "ERROR: $out already exists"; exit 1; }
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -U openexam -Fc openexam > "$out"

# Fail loudly on empty dumps rather than silently rotating good ones away.
[ -s "$out" ] || { echo "ERROR: empty dump $out"; rm -f "$out"; exit 1; }

find "$BACKUP_DIR" -name 'openexam-*.dump' -mtime "+$RETENTION_DAYS" -delete

# node-exporter textfile-collector metric, for the WalGBackupStale-style
# staleness alert (monitoring/prometheus/rules/alerts.yml's PgDumpBackupStale)
# — only written when the monitoring stack's directory exists, so a default
# install without scripts/setup-monitoring.sh doesn't create it unprompted.
# Atomic write (temp file + mv): the collector reads this directory on its
# own schedule and would otherwise risk scraping a half-written file.
metrics_dir="./monitoring-data/textfile-collector"
if [ -d "$metrics_dir" ]; then
  metrics_tmp="$(mktemp "$metrics_dir/.pg_dump_backup.XXXXXX")"
  {
    echo "# HELP openexam_backup_last_success_timestamp_seconds Unix timestamp of the last successful backup"
    echo "# TYPE openexam_backup_last_success_timestamp_seconds gauge"
    echo "openexam_backup_last_success_timestamp_seconds{job=\"pg_dump\"} $(date +%s)"
  } > "$metrics_tmp"
  # World-readable: this script's umask 077 (above) is right for the dump
  # itself (contains PII) but wrong here — node-exporter's container runs as
  # a different, non-root UID and needs to read this file, and it holds
  # nothing more sensitive than a timestamp.
  chmod 644 "$metrics_tmp"
  mv "$metrics_tmp" "$metrics_dir/pg_dump_backup.prom"
fi

echo "OK: $out ($(du -h "$out" | cut -f1))"
