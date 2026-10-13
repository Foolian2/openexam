#!/usr/bin/env bash
# Major-version upgrade of the production Postgres cluster, 16 -> 18, via
# pg_upgrade --swap. Full runbook: DEPLOYMENT.md's "Major Postgres version
# upgrade".
#
# DESTRUCTIVE and IRREVERSIBLE — like scripts/pitr-restore.sh, and more so.
# pg_upgrade --swap MOVES the old cluster's data files into the new cluster
# rather than copying them, so from the moment the transfer starts there is
# no old cluster left to fall back to. The pg_dump this script takes first
# is the only rollback path that exists afterwards: restore it into a
# postgres:16 container. Requires --yes-i-am-sure on purpose.
#
# Rehearse against a throwaway copy of the volume before running this for
# real (DEPLOYMENT.md). Never rehearse against production.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/production-compose.sh
OLD_MAJOR=16
NEW_MAJOR=18
UPGRADE_IMAGE=openexam-postgres-upgrade:latest
# The cluster superuser, which is NOT "postgres" here: the image was
# initialized with POSTGRES_USER=openexam (docker-compose.prod.yml), so that
# is the only superuser the cluster has. pg_upgrade otherwise defaults to the
# OS user it runs as and dies with `role "postgres" does not exist` while
# connecting to the old cluster during --check.
SUPERUSER=openexam

usage() {
  cat <<'EOF'
Usage:
  scripts/pg-upgrade.sh --yes-i-am-sure [--enable-checksums]

--yes-i-am-sure     Required. This upgrades the live postgres_data volume in
                    place and leaves no old cluster to roll back to.
--enable-checksums  Turn data checksums ON as part of the upgrade. Postgres
                    18's initdb enables them by default, but pg_upgrade
                    requires both clusters to agree, and the existing 16
                    cluster was created without them — so by default the new
                    cluster is initdb'd with --no-data-checksums to match.
                    This flag instead runs `pg_checksums --enable` over the
                    old cluster first (it is already shut down at that
                    point) and initdb's the new one with checksums on. That
                    rewrites every page: budget extra downtime roughly
                    proportional to database size.
EOF
}

confirmed=false
enable_checksums=false
while [ $# -gt 0 ]; do
  case "$1" in
    --yes-i-am-sure) confirmed=true; shift ;;
    --enable-checksums) enable_checksums=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [ "$confirmed" != true ]; then
  echo "ERROR: this upgrades the live postgres_data volume IN PLACE and is not reversible." >&2
  echo "Re-run with --yes-i-am-sure once you've read DEPLOYMENT.md's \"Major Postgres version upgrade\"." >&2
  exit 1
fi

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (copy .env.example)"; exit 1; }
require_walg_secrets

# ── 0. Confirm there is actually an old cluster to upgrade ───────────────
# Reads PG_VERSION straight off the volume rather than asking the server, so
# a re-run after a completed upgrade stops here instead of doing anything.
cid="$("${COMPOSE[@]}" ps -q postgres || true)"
[ -n "$cid" ] || { echo "ERROR: postgres service is not running — start the stack first." >&2; exit 1; }

# The volume name carries the Compose project prefix, which depends on the
# checkout directory. Read it off the container instead of reconstructing it.
volume="$(docker inspect -f \
  '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$cid")"
[ -n "$volume" ] || { echo "ERROR: could not find the postgres_data volume on container $cid." >&2; exit 1; }

# `$PGDATA` expands INSIDE the container, same reasoning as
# scripts/pitr-backup.sh: the host shell has no PGDATA of its own.
current="$("${COMPOSE[@]}" exec -T postgres sh -c 'cat "$PGDATA/PG_VERSION"' | tr -d '[:space:]')"
if [ "$current" = "$NEW_MAJOR" ]; then
  echo "Cluster is already on Postgres $NEW_MAJOR — nothing to do."
  exit 0
fi
if [ "$current" != "$OLD_MAJOR" ]; then
  echo "ERROR: expected a Postgres $OLD_MAJOR cluster, found $current. Aborting." >&2
  exit 1
fi

# The new cluster must be initdb'd with the SAME encoding and locale as the
# old one or pg_upgrade refuses. template0 carries what initdb originally
# used, so read it from there while the server is still up.
# Pipe-separated, not space-separated: locale names are not guaranteed to be
# free of spaces and a split in the wrong place would silently initdb the new
# cluster with the wrong collation.
IFS='|' read -r encoding collate ctype <<EOF
$("${COMPOSE[@]}" exec -T postgres psql -U openexam -tAF'|' -c \
  "SELECT pg_encoding_to_char(encoding), datcollate, datctype FROM pg_database WHERE datname = 'template0'")
EOF
[ -n "$encoding" ] && [ -n "$collate" ] && [ -n "$ctype" ] || {
  echo "ERROR: could not read encoding/locale from template0." >&2; exit 1; }
echo "Old cluster: Postgres $current, encoding=$encoding collate=$collate ctype=$ctype, volume=$volume"

# ── 1. The only rollback path there will be ──────────────────────────────
echo
echo "Taking a pre-upgrade pg_dump (this is the ONLY rollback path after the swap)..."
dump_before="$(ls -1 ./backups/openexam-*.dump 2>/dev/null | tail -n1 || true)"
scripts/backup.sh
dump="$(ls -1 ./backups/openexam-*.dump | tail -n1)"
[ "$dump" != "$dump_before" ] || { echo "ERROR: backup.sh produced no new dump." >&2; exit 1; }
echo "Pre-upgrade dump: $dump"

# ── 2. Quiesce ───────────────────────────────────────────────────────────
echo
echo "Stopping the app tier..."
"${COMPOSE[@]}" stop web ws-backend
echo "Stopping postgres (a clean shutdown is a hard pg_upgrade prerequisite)..."
"${COMPOSE[@]}" stop postgres

# ── 3. Build the two-major image ─────────────────────────────────────────
echo
echo "Building $UPGRADE_IMAGE (Postgres $NEW_MAJOR + $OLD_MAJOR binaries)..."
docker build -f infra/postgres/upgrade.Dockerfile -t "$UPGRADE_IMAGE" infra/postgres

# ── 4. The upgrade itself ────────────────────────────────────────────────
# Why the directory shuffle below: the volume is mounted AS the data
# directory (postgres_data:/var/lib/postgresql/data), so the volume root IS
# the 16 cluster and there is nowhere alongside it to put an 18 cluster.
# --swap only works when both clusters share a filesystem, so the script
# mounts the volume at its own root (/pgvol) and moves the 16 cluster down
# into /pgvol/16, leaving room for /pgvol/18. Those moves — and the ones
# that put the upgraded cluster back at the volume root at the end — are
# renames within one filesystem: metadata only, no data copied.
#
# --sync-method=fsync rather than the syncfs default: --swap leaves a large
# number of garbage files behind in the old directory, which makes syncfs
# markedly slower (pg_upgrade's own documented advice).
echo
echo "Running pg_upgrade --swap..."
docker run --rm -v "$volume:/pgvol" \
  -e PG_ENCODING="$encoding" -e PG_COLLATE="$collate" -e PG_CTYPE="$ctype" \
  -e ENABLE_CHECKSUMS="$enable_checksums" \
  "$UPGRADE_IMAGE" bash -euo pipefail -c '
    old=/pgvol/'"$OLD_MAJOR"'
    new=/pgvol/'"$NEW_MAJOR"'
    oldbin=/usr/lib/postgresql/'"$OLD_MAJOR"'/bin
    newbin=/usr/lib/postgresql/'"$NEW_MAJOR"'/bin

    # pg_upgrade writes its logs to pg_upgrade_output.d in the working
    # directory, and deletes them on success. This container is --rm, so
    # anywhere but the volume means a failed run takes its own diagnostics
    # with it. Working from the volume root keeps them on disk for the
    # operator; the cleanup before the final move-up covers the case where
    # pg_upgrade left them behind after a partial success.
    cd /pgvol

    # Everything up to and including --check is non-destructive in intent, but
    # the directory shuffle below has already emptied the volume root by then.
    # Without the restore in on_failure, a --check that legitimately refuses
    # the cluster (an extension with no '"$NEW_MAJOR"' build, say) would leave
    # PGDATA at $old, where nothing expects it: the stack could not be started
    # again, and this script could not be re-run because step 0 requires a
    # running postgres service. Flipped immediately before the swap, after
    # which moving anything back is no longer possible.
    swap_started=false

    on_failure() {
      echo >&2
      echo "FAILED. Diagnostics, if pg_upgrade got far enough to write any:" >&2
      echo "  docker run --rm -v '"$volume"':/pgvol '"$UPGRADE_IMAGE"' \\" >&2
      echo "    find /pgvol/pg_upgrade_output.d -type f" >&2

      if [ "$swap_started" != true ] && [ -f "$old/PG_VERSION" ]; then
        echo >&2
        echo "No data was moved yet — restoring the original volume layout..." >&2
        # The new cluster is a fresh initdb with nothing in it; drop it first
        # so the root is clear for the originals to move back.
        rm -rf "$new"
        if find "$old" -mindepth 1 -maxdepth 1 -exec mv -t /pgvol {} + &&
          rmdir "$old"; then
          echo "Restored: the Postgres '"$OLD_MAJOR"' cluster is back at the volume" >&2
          echo "root and the stack can be started again with:" >&2
          echo "  '"$COMPOSE_CMD"' up -d" >&2
        else
          echo "WARNING: automatic restore FAILED. The cluster is intact but still" >&2
          echo "at $old inside the volume — move its contents back to the volume" >&2
          echo "root before starting the stack. See DEPLOYMENT.md." >&2
        fi
      elif [ -f "$new/PG_VERSION" ] && ! [ -f "$old/PG_VERSION" ]; then
        echo >&2
        echo "NOTE: the upgraded cluster appears to be at $new but was not moved" >&2
        echo "back to the volume root. Do NOT start the stack — see DEPLOYMENT.md." >&2
      fi
    }
    trap on_failure ERR

    if [ -f /pgvol/PG_VERSION ]; then
      echo "Moving the existing cluster into $old ..."
      # 0700, not whatever the umask gives: a data directory readable by
      # group or other makes the postmaster refuse to start with "data
      # directory has invalid permissions". pg_upgrade --check boots the old
      # cluster to inspect it, so a plain `mkdir -p` (0755) aborts the
      # upgrade at the check with a connection error that names a socket
      # rather than the real cause. The volume root itself is already 0700 —
      # this only restores that mode on the subdirectory the cluster moves
      # into.
      mkdir -p "$old"
      find /pgvol -mindepth 1 -maxdepth 1 \
        ! -name "'"$OLD_MAJOR"'" ! -name "'"$NEW_MAJOR"'" \
        -exec mv -t "$old" {} +
    fi
    [ -f "$old/PG_VERSION" ] || { echo "ERROR: no cluster at $old" >&2; exit 1; }
    # Applied outside the branch above on purpose: a re-run after a partial
    # failure finds the cluster already at $old and skips the move entirely,
    # which would leave the bad mode in place and fail again the same way.
    chmod 0700 "$old"

    if [ "$ENABLE_CHECKSUMS" = true ]; then
      echo "Enabling data checksums on the old cluster (rewrites every page)..."
      "$oldbin/pg_checksums" --enable -D "$old"
      checksum_arg=""
    else
      checksum_arg="--no-data-checksums"
    fi

    echo "initdb-ing the Postgres '"$NEW_MAJOR"' cluster..."
    rm -rf "$new"
    # shellcheck disable=SC2086
    # --username must match the old cluster superuser: initdb otherwise names
    # it after the OS user (postgres), and pg_upgrade — which connects to BOTH
    # clusters as the same role — then fails against the target cluster with a
    # "role does not exist" error.
    "$newbin/initdb" -D "$new" $checksum_arg --username="'"$SUPERUSER"'" \
      --encoding="$PG_ENCODING" --lc-collate="$PG_COLLATE" --lc-ctype="$PG_CTYPE"

    # pg_upgrade does not carry the client-authentication config across, and
    # the old cluster is deleted by the swap, so this is the only chance to
    # keep it. A bare initdb writes an hba that admits local and 127.0.0.1
    # only; the app tier connects over the compose network, so without this
    # every container is refused with "no pg_hba.conf entry" (Prisma reports
    # it as P1010, naming the container IP rather than the cause) and the
    # stack comes back up with a healthy database nothing can reach.
    #
    # Only the auth files. postgresql.conf is deliberately NOT copied: it can
    # carry settings the new major has removed, which would stop the upgraded
    # cluster from starting at all — a worse failure than the one above.
    echo "Preserving pg_hba.conf / pg_ident.conf from the old cluster..."
    for cfg in pg_hba.conf pg_ident.conf; do
      [ -f "$old/$cfg" ] && cp -p "$old/$cfg" "$new/$cfg"
    done

    echo "Checking..."
    "$newbin/pg_upgrade" -b "$oldbin" -B "$newbin" -d "$old" -D "$new" \
      --username="'"$SUPERUSER"'" \
      --socketdir=/tmp --jobs "$(nproc)" --check

    echo "Upgrading..."
    # Past this line the old cluster is being dismantled: --swap MOVES data
    # files into $new, so on_failure must stop offering to restore.
    swap_started=true
    "$newbin/pg_upgrade" -b "$oldbin" -B "$newbin" -d "$old" -D "$new" \
      --username="'"$SUPERUSER"'" \
      --socketdir=/tmp --jobs "$(nproc)" --swap --sync-method=fsync

    # --swap moved the data files INTO $new, so $old is now wreckage. Clear
    # it, then lift the upgraded cluster back up to the volume root, which
    # is where docker-compose.prod.yml, pitr-backup.sh and pitr-restore.sh
    # all expect PGDATA to be.
    echo "Restoring the volume layout..."
    rm -rf "$old" /pgvol/pg_upgrade_output.d
    find "$new" -mindepth 1 -maxdepth 1 -exec mv -t /pgvol {} +
    rmdir "$new"
    echo "Cluster at volume root is now Postgres $(cat /pgvol/PG_VERSION)."
  '

# ── 5. Back up ───────────────────────────────────────────────────────────
echo
echo "Starting the upgraded cluster..."
# --build is required, not cosmetic: openexam-postgres:latest is a fixed tag
# still pointing at the Postgres OLD_MAJOR image built for the previous
# deploy, and phase 3 above builds only the separate openexam-postgres-upgrade
# tag. A bare `up` would start the old binary against the freshly upgraded
# data directory, which refuses to boot — with the volume already converted
# and no old cluster left to fall back to.
"${COMPOSE[@]}" up -d --build postgres
for _ in $(seq 1 60); do
  "${COMPOSE[@]}" exec -T postgres pg_isready -U openexam >/dev/null 2>&1 && break
  sleep 5
done
"${COMPOSE[@]}" exec -T postgres pg_isready -U openexam >/dev/null 2>&1 || {
  echo "ERROR: postgres did not come up within 5 minutes. Logs:" >&2
  echo "  $COMPOSE_CMD logs postgres" >&2
  exit 1; }
"${COMPOSE[@]}" exec -T postgres psql -U openexam -c 'SELECT version();'

# The upgrade also moves the OS base from Debian bookworm to trixie, which
# changes the libc collation version recorded for every database. Postgres
# warns that indexes built under the old collation definition may now be
# subtly out of order — a corrupt index that returns wrong results for range
# and equality lookups rather than failing loudly. pg_upgrade carries indexes
# over as-is and does not rebuild them, so this has to happen here, before
# anything reads from the cluster.
#
# Order matters: rebuild first, then record that the indexes match the new
# collation. REFRESH COLLATION VERSION only updates the bookkeeping — running
# it first would clear the warning while leaving the bad indexes in place.
echo
echo "Rebuilding indexes for the new libc collation (this is the slow step)..."
"${COMPOSE[@]}" exec -T postgres reindexdb -U openexam --all

echo
echo "Refreshing recorded collation versions..."
"${COMPOSE[@]}" exec -T postgres psql -U openexam -tA \
  -c "SELECT datname FROM pg_database WHERE datallowconn" |
  while read -r db; do
    [ -n "$db" ] || continue
    "${COMPOSE[@]}" exec -T postgres psql -U openexam -d "$db" \
      -c "ALTER DATABASE \"$db\" REFRESH COLLATION VERSION"
  done

# Postgres 18 carries planner statistics across the upgrade, so this is no
# longer the "queries are terrible until it finishes" step it used to be —
# but pg_upgrade still recommends it, and extended statistics objects are
# not carried over.
echo
echo "Refreshing statistics..."
"${COMPOSE[@]}" exec -T postgres vacuumdb -U openexam --all --analyze-in-stages

echo
echo "Restarting the app tier..."
"${COMPOSE[@]}" up -d web ws-backend

# ── 6. Re-baseline PITR ──────────────────────────────────────────────────
# Everything already in the WAL archive belongs to the old cluster and can
# only be restored with a Postgres 16 binary. Until a new base backup lands,
# point-in-time recovery of the upgraded cluster is not possible — so this
# runs now rather than waiting for the nightly cron line.
echo
no_baseline="NO PITR baseline was taken: only the pre-upgrade dump and daily
                     pg_dump (scripts/backup.sh) can restore this cluster."
if [ "$walg_backend" = disabled ]; then
  echo "NOTE: WALG_STORAGE_BACKEND=disabled, so no PITR baseline was taken." >&2
  echo "Daily pg_dump via scripts/backup.sh still applies." >&2
  pitr_summary=$no_baseline
elif ! "${COMPOSE[@]}" exec -T postgres sh -c 'command -v wal-g' >/dev/null 2>&1; then
  echo "NOTE: wal-g is not present in the postgres image, so no PITR baseline was taken." >&2
  echo "Daily pg_dump via scripts/backup.sh still applies." >&2
  pitr_summary=$no_baseline
else
  echo "Pushing a fresh wal-g base backup to re-baseline PITR..."
  scripts/pitr-backup.sh
  pitr_summary="The base backup just pushed is the new PITR baseline."
fi

cat <<EOF

Upgrade complete.

  Pre-upgrade dump : $dump
                     Keep this offsite. Restoring it into a postgres:$OLD_MAJOR
                     container is the only way back to $OLD_MAJOR.
  Old WAL archive  : belongs to the $OLD_MAJOR cluster and cannot restore this one.
                     $pitr_summary

Next: run an exam end to end, then check the Grafana dashboard — a collector
that trips over a renamed system view leaves panels blank rather than alerting.
EOF
