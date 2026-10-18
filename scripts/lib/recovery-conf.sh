#!/bin/sh
# Install the recovery settings for a --latest restore, scrubbing any left by
# an earlier one first.
#
# Postgres raises "multiple recovery targets specified" at recovery start when
# more than one recovery_target* is set. The historical restore path used to
# write recovery_target_time into postgresql.auto.conf and never remove it, and
# pitr-backup.sh's wal-g backup-push carries that file into later base backups —
# so appending ours on top of a stale target would make the only supported
# recovery path fail *after* PGDATA had already been replaced. Scrub, then
# append.
#
# restore_command is reset for the same reason: the fetched base backup may
# carry the value from the cluster it was taken from.
#
# Rewrite via a sibling temp file rather than `sed -i`: GNU sed wants
# `sed -i`, BSD/macOS sed wants `sed -i ''`, and this runs both in the postgres
# container and in tests on a developer Mac. A sibling rename stays on the same
# filesystem, so the swap is atomic.
#
# Usage: PGDATA=/path/to/pgdata sh recovery-conf.sh
set -e

: "${PGDATA:?PGDATA must point at the restored data directory}"
conf="$PGDATA/postgresql.auto.conf"

if [ -f "$conf" ]; then
  tmp="$conf.openexam-scrub.$$"
  sed "/^restore_command[[:space:]]*=/d; /^recovery_target[a-z_]*[[:space:]]*=/d" "$conf" > "$tmp"
  mv "$tmp" "$conf"
fi

{
  echo "restore_command = 'wal-g wal-fetch %f %p'"
  # --latest: stop at the first consistent state, i.e. no WAL replay past the
  # base backup. Historical recovery_target_time targets are refused at the
  # CLI until scratch-volume validation exists — see DEPLOYMENT.md.
  echo "recovery_target = 'immediate'"
  echo "recovery_target_action = 'promote'"
} >> "$conf"
