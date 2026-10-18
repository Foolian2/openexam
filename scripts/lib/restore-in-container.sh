#!/bin/sh
# The fetch-and-replace half of a --latest restore. Runs INSIDE the postgres
# container, piped in by scripts/pitr-restore.sh together with
# scripts/lib/recovery-conf.sh (which must come second — the recovery settings
# have to be rewritten after the fetched files land).
#
# Fetch into a staging directory FIRST and only replace the data directory
# once the fetch has succeeded. Wiping first and fetching second — the old
# order — leaves an empty PGDATA when the fetch fails part-way (corrupt
# archive, tunnel drop mid-fetch), destroying the live cluster with nothing
# to fall back to.
#
# Usage: PGDATA=/path/to/pgdata sh restore-in-container.sh   (wal-g on PATH)
set -e

: "${PGDATA:?PGDATA must point at the data directory to replace}"

staging="$PGDATA/.restore-staging"
rm -rf "$staging"
mkdir -p "$staging"

if ! wal-g backup-fetch "$staging" LATEST; then
  # Leave PGDATA exactly as we found it.
  rm -rf "$staging"
  echo "ERROR: wal-g backup-fetch failed; existing data left untouched." >&2
  exit 1
fi

# The fetch succeeded — only now replace the data directory contents. Keep
# the staging directory itself out of the swap, then drop it.
find "$PGDATA" -mindepth 1 -maxdepth 1 ! -name .restore-staging -exec rm -rf {} +
cp -a "$staging"/. "$PGDATA"/
rm -rf "$staging"

touch "$PGDATA/recovery.signal"
