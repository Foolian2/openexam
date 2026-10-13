#!/usr/bin/env bash
# Offsite copies of the daily pg_dumps and .env.prod, via rclone run from a
# pinned Docker image — nothing to install on the host. The remote is set up
# by `./openexam backup-offsite` (which writes .rclone.conf, chmod 600,
# gitignored); this script only uses it.
#
#   ./scripts/offsite.sh push [--fresh]   copy new dumps + .env.prod offsite
#   ./scripts/offsite.sh list             remote dumps (name;bytes), newest first
#   ./scripts/offsite.sh fetch NAME DIR   download one dump into DIR
#   ./scripts/offsite.sh fetch-env DEST   download the offsite .env.prod copy
#   ./scripts/offsite.sh rclone ARGS...   raw rclone with this config
#
# `push` is what cron runs (scripts/install-cron.sh adds it at 03:15, after
# the 03:00 backup). It skips dumps younger than an hour so it can never ship
# one still being written — the same --min-age guard DEPLOYMENT.md's DR
# section uses; --fresh drops that guard for an on-demand push right after
# scripts/backup.sh has finished. Remote dumps older than
# OFFSITE_RETENTION_DAYS (default 30) are deleted, so the offsite copy keeps
# a longer history than the 14 days kept locally.
#
# The remote is always called "offsite" in .rclone.conf: an rclone `crypt`
# remote (client-side encryption — the dumps are student PII and .env.prod
# holds every key) or, if encryption was declined, an `alias`, both layered
# over the actual target "offsite-target".
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

RCLONE_IMAGE="rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5"
CONF="${OE_RCLONE_CONF:-.rclone.conf}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-30}"

[ -f "$CONF" ] || { echo "ERROR: no offsite target configured ($CONF missing) — run ./openexam backup-offsite" >&2; exit 1; }

# A "local" target (a NAS mounted on this host) has to be mounted into the
# container at the same path; ./openexam backup-offsite records it here.
local_path=$(sed -n 's/^# openexam-local-path: //p' "$CONF" | head -1)

# rclone [docker-run-args...] -- rclone-args...
rclone_run() {
  local -a docker_args
  docker_args=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    docker_args+=("$1")
    shift
  done
  shift
  [ -n "$local_path" ] && docker_args+=(-v "$local_path:$local_path")
  docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    -e RCLONE_CONFIG=/config/rclone.conf \
    -e RCLONE_CACHE_DIR=/tmp/rclone-cache \
    -v "$PWD/$CONF:/config/rclone.conf" \
    ${docker_args[@]+"${docker_args[@]}"} \
    "$RCLONE_IMAGE" "$@"
}

cmd="${1:-}"
[ $# -gt 0 ] && shift

case "$cmd" in
  push)
    min_age=(--min-age 1h)
    [ "${1:-}" = --fresh ] && min_age=()
    mkdir -p "$BACKUP_DIR"
    rclone_run -v "$(cd "$BACKUP_DIR" && pwd):/data/backups:ro" -- \
      copy /data/backups offsite:dumps --include 'openexam-*.dump' \
      ${min_age[@]+"${min_age[@]}"} --stats-one-line --stats 0 -v
    if [ -f .env.prod ]; then
      rclone_run -v "$PWD/.env.prod:/data/env/.env.prod:ro" -- \
        copyto /data/env/.env.prod offsite:env/.env.prod -v
    fi
    rclone_run -- delete offsite:dumps --min-age "${RETENTION_DAYS}d" --include 'openexam-*.dump' -v
    count=$(rclone_run -- lsf offsite:dumps --include 'openexam-*.dump' | wc -l | tr -d ' ')
    echo "OK: offsite holds $count dump(s) + .env.prod ($(date '+%F %T'))"
    ;;
  list)
    rclone_run -- lsf offsite:dumps --include 'openexam-*.dump' --format 'ps' --separator ';' \
      | sort -r
    ;;
  fetch)
    name="${1:?usage: offsite.sh fetch NAME DIR}"
    dest="${2:?usage: offsite.sh fetch NAME DIR}"
    case "$name" in */* | ..*) echo "ERROR: bad dump name" >&2; exit 1 ;; esac
    mkdir -p "$dest"
    rclone_run -v "$(cd "$dest" && pwd):/data/out" -- copyto "offsite:dumps/$name" "/data/out/$name"
    echo "$dest/$name"
    ;;
  fetch-env)
    dest="${1:?usage: offsite.sh fetch-env DEST}"
    dir=$(cd "$(dirname "$dest")" && pwd)
    rclone_run -v "$dir:/data/out" -- copyto offsite:env/.env.prod "/data/out/$(basename "$dest")"
    chmod 600 "$dest"
    ;;
  rclone)
    rclone_run -- "$@"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
