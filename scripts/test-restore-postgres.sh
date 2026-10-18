#!/usr/bin/env bash
# A real restore drill in a fresh, unexposed container; never uses live volumes.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f -v "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
container=$(docker run --rm -d --network none -e POSTGRES_USER=openexam \
  -e POSTGRES_DB=openexam -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine)
ready=0
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U openexam >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo 'FAIL: scratch database did not start'; exit 1; }
docker exec "$container" psql -U openexam -d openexam -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE saved_answer (value text); INSERT INTO saved_answer VALUES ('original');" >/dev/null
docker exec "$container" pg_dump -U openexam -d openexam -Fc > "$scratch/valid.dump"
docker exec "$container" psql -U openexam -d openexam -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE sentinel (value text); INSERT INTO sentinel VALUES ('keep');" >/dev/null
. scripts/cli/backup.sh
oe_prod() {
  # Drop only the compose exec prefix; use the freshly created container ID.
  shift 3
  docker exec -i "$container" "$@"
}
printf 'invalid nonempty archive' > "$scratch/invalid.dump"
if oe_pg_restore "$scratch/invalid.dump"; then echo 'FAIL: invalid archive accepted'; exit 1; fi
[ "$(docker exec "$container" psql -U openexam -d openexam -tAc 'SELECT value FROM sentinel')" = keep ]

# A truncated real archive is the shape that actually bit: the header and TOC
# still parse, so pg_restore emits a valid schema prefix before it runs out of
# data. Under the old pipe ordering that prefix — with its DROP/CREATE —
# reached psql and committed even though the producer had failed. Cut at
# several points so neither "too short to parse" nor "almost complete" hides
# the regression.
dumpsize=$(wc -c < "$scratch/valid.dump")
for frac in 1 2 3; do
  nbytes=$((dumpsize * frac / 4))
  [ "$nbytes" -gt 0 ] || continue
  head -c "$nbytes" "$scratch/valid.dump" > "$scratch/truncated.dump"
  if oe_pg_restore "$scratch/truncated.dump"; then
    echo "FAIL: truncated archive accepted (first $nbytes bytes)"
    exit 1
  fi
  [ "$(docker exec "$container" psql -U openexam -d openexam -tAc 'SELECT value FROM sentinel')" = keep ] \
    || { echo "FAIL: sentinel lost to a truncated archive (first $nbytes bytes)"; exit 1; }
done

oe_pg_restore "$scratch/valid.dump"
[ "$(docker exec "$container" psql -U openexam -d openexam -tAc 'SELECT value FROM saved_answer')" = original ]
[ "$(docker exec "$container" psql -U openexam -d openexam -tAc "SELECT to_regclass('public.sentinel') IS NULL")" = t ]
# The fetch-and-replace half of the restore, run exactly as pitr-restore.sh
# runs it (both library scripts concatenated, then `sh -s`) against a scratch
# PGDATA with a stub wal-g. A fetch that fails part-way must leave the existing
# data directory untouched: the old order wiped first, so a failed fetch
# destroyed the live cluster with nothing to fall back to.
mkdir -p "$scratch/bin"
cat > "$scratch/bin/wal-g" <<'STUB'
#!/bin/sh
[ "$1" = backup-fetch ] || exit 1
if [ "${STUB_FETCH_FAIL:-0}" = 1 ]; then
  printf 'partial' > "$2/basebackups.txt"
  exit 1
fi
printf 'fetched\n' > "$2/PG_VERSION"
mkdir -p "$2/base"
printf 'x\n' > "$2/base/1"
exit 0
STUB
chmod +x "$scratch/bin/wal-g"

restore_program() {
  cat scripts/lib/restore-in-container.sh scripts/lib/recovery-conf.sh |
    PGDATA="$scratch/pgdata" PATH="$scratch/bin:$PATH" sh -s
}

mkdir -p "$scratch/pgdata/old-tablespace"
printf 'live cluster\n' > "$scratch/pgdata/important.dat"

if STUB_FETCH_FAIL=1 restore_program > "$scratch/fetch-fail" 2>&1; then
  echo 'FAIL: a failed fetch reported success'
  sed 's/^/  /' "$scratch/fetch-fail"
  exit 1
fi
[ -f "$scratch/pgdata/important.dat" ] \
  || { echo 'FAIL: a failed fetch destroyed the existing data directory'; exit 1; }
[ ! -e "$scratch/pgdata/.restore-staging" ] \
  || { echo 'FAIL: a failed fetch left a staging directory behind'; exit 1; }

restore_program > "$scratch/fetch-ok" 2>&1 \
  || { echo 'FAIL: a successful fetch was rejected'; sed 's/^/  /' "$scratch/fetch-ok"; exit 1; }
[ -f "$scratch/pgdata/PG_VERSION" ] || { echo 'FAIL: fetched data missing after restore'; exit 1; }
[ ! -e "$scratch/pgdata/important.dat" ] || { echo 'FAIL: stale data survived the restore'; exit 1; }
[ ! -e "$scratch/pgdata/old-tablespace" ] || { echo 'FAIL: stale directory survived the restore'; exit 1; }
[ ! -e "$scratch/pgdata/.restore-staging" ] || { echo 'FAIL: staging directory not cleaned up'; exit 1; }
grep -q "^recovery_target = 'immediate'" "$scratch/pgdata/postgresql.auto.conf" \
  || { echo 'FAIL: recovery settings not installed after the swap'; exit 1; }

# Regression for the recovery-target clash. A recovery_target_time written by
# an earlier historical restore survives into later base backups via
# pitr-backup.sh's wal-g backup-push; appending recovery_target = 'immediate'
# on top of it makes Postgres refuse to start with "multiple recovery targets
# specified" — and it would only do so after PGDATA had already been replaced.
# The scrub must remove it, leave unrelated settings alone, and be idempotent.
mkdir -p "$scratch/pgdata"
conf="$scratch/pgdata/postgresql.auto.conf"
cat > "$conf" <<'CONF'
max_connections = 100
shared_buffers = 128MB
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_time = '2026-08-13 12:00:00+00'
recovery_target_action = 'promote'
CONF
PGDATA="$scratch/pgdata" sh scripts/lib/recovery-conf.sh
grep -q 'recovery_target_time' "$conf" \
  && { echo 'FAIL: stale recovery_target_time survived the scrub'; cat "$conf"; exit 1; }
[ "$(grep -c '^recovery_target' "$conf")" = 2 ] \
  || { echo 'FAIL: expected exactly recovery_target and recovery_target_action'; cat "$conf"; exit 1; }
grep -q "^restore_command = 'wal-g wal-fetch %f %p'" "$conf" \
  || { echo 'FAIL: restore_command not installed'; cat "$conf"; exit 1; }
[ "$(grep -c '^restore_command' "$conf")" = 1 ] \
  || { echo 'FAIL: restore_command duplicated'; cat "$conf"; exit 1; }
grep -q '^max_connections = 100' "$conf" \
  || { echo 'FAIL: unrelated setting lost'; cat "$conf"; exit 1; }
PGDATA="$scratch/pgdata" sh scripts/lib/recovery-conf.sh
[ "$(grep -c '^recovery_target' "$conf")" = 2 ] \
  || { echo 'FAIL: re-running the restore duplicated recovery settings'; cat "$conf"; exit 1; }

echo 'ok: PostgreSQL preserves the original schema on invalid and truncated input and restores valid archives'
echo 'ok: recovery settings are rewritten, not appended, and are idempotent'
