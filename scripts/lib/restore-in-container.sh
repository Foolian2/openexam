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
# The replacement itself swaps by rename, not by copy. Staging lives inside
# PGDATA, so parking the old entries aside and moving the fetched ones in
# costs no disk space and cannot stop half-way on ENOSPC the way `rm -rf` +
# `cp -a` did — that needed a second full copy of the backup to fit *after*
# the live cluster had already been deleted, so a full disk meant a partial
# cluster and no rollback. The parked entries stay in .restore-old until
# every fetched file has landed.
#
# Usage: PGDATA=/path/to/pgdata sh restore-in-container.sh   (wal-g on PATH)
set -e

: "${PGDATA:?PGDATA must point at the data directory to replace}"

staging="$PGDATA/.restore-staging"
old="$PGDATA/.restore-old"

if [ -e "$old" ]; then
  echo "ERROR: $old exists — a previous restore was interrupted mid-swap." >&2
  echo "       It holds the pre-restore cluster; inspect it before re-running." >&2
  exit 1
fi

rm -rf "$staging"
mkdir -p "$staging"

if ! wal-g backup-fetch "$staging" LATEST; then
  # Leave PGDATA exactly as we found it.
  rm -rf "$staging"
  echo "ERROR: wal-g backup-fetch failed; existing data left untouched." >&2
  exit 1
fi

# move_entries SRC DST — rename every entry of SRC (dotfiles included) into
# DST. Renames only, never copies: both directories are inside PGDATA, so
# each move is a same-filesystem rename. The staging/old bookkeeping
# directories are skipped so a move loop never consumes its own workspaces.
move_entries() {
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || continue
    case "$entry" in
      */.restore-staging | */.restore-old) continue ;;
    esac
    mv "$entry" "$2"/ || return 1
  done
}

# The fetch succeeded — only now replace the data directory contents: park
# the current entries in .restore-old, move the fetched ones in, and drop the
# parked copy last.
mkdir "$old"
if ! move_entries "$PGDATA" "$old"; then
  # Nothing has been replaced yet — put the parked entries straight back.
  move_entries "$old" "$PGDATA" || true
  rmdir "$old" 2>/dev/null || true
  rm -rf "$staging"
  echo "ERROR: could not move the old data directory aside; PGDATA restored" >&2
  echo "       where possible, any remainder is in $old." >&2
  exit 1
fi
if ! move_entries "$staging" "$PGDATA"; then
  # Put both copies back where they started: fetched files to staging, the
  # parked cluster to PGDATA. Nothing is dropped on failure.
  move_entries "$PGDATA" "$staging" || true
  move_entries "$old" "$PGDATA" || true
  rmdir "$old" 2>/dev/null || true
  echo "ERROR: could not move the fetched files into place; the previous" >&2
  echo "       cluster was restored where possible and the fetched copy is" >&2
  echo "       kept in $staging (any remainder of the old one in $old)." >&2
  exit 1
fi
rm -rf "$staging" "$old"

touch "$PGDATA/recovery.signal"
