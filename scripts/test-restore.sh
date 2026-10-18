#!/usr/bin/env bash
# Command-boundary tests only: never invokes Docker or a real database.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/cli/backup.sh
scratch=$(mktemp -d)
restore_pid=""
sub_pid=""
cleanup() {
  if [ -n "$sub_pid" ]; then kill -TERM -- "$sub_pid" 2>/dev/null || true; fi
  if [ -n "$restore_pid" ]; then kill -TERM -- "$restore_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
# Both the override and TMPDIR point at scratch, so the leak guard also
# catches code that only honors TMPDIR (the pre-review implementation).
export TMPDIR="$scratch"
export OE_RESTORE_SPOOL_DIR="$scratch"
export CAPTURE="$scratch/sql"
spool_leaked() {
  [ -n "$(find "$OE_RESTORE_SPOOL_DIR" -type f -name 'openexam-restore-sql.*' 2>/dev/null)" ]
}
oe_prod() {
  case "$*" in
    *pg_restore*) cat >/dev/null; printf 'SELECT 1;\n'; return "${ARCHIVE_EXIT:-0}" ;;
    *psql*) cat > "$CAPTURE" ;;
    *) return 99 ;;
  esac
}
printf invalid > "$scratch/archive"
ARCHIVE_EXIT=1
if oe_pg_restore "$scratch/archive" > "$scratch/invalid.log" 2>&1; then
  echo 'FAIL: invalid archive accepted'; exit 1
fi
grep -q 'restore aborted before any change' "$scratch/invalid.log" \
  || { echo 'FAIL: producer failure does not report aborting before any change'; exit 1; }
if [ -e "$CAPTURE" ]; then echo 'FAIL: invalid archive reached SQL consumer'; exit 1; fi
if spool_leaked; then echo 'FAIL: failed archive left the restore spool behind'; exit 1; fi
ARCHIVE_EXIT=0
oe_pg_restore "$scratch/archive"
grep -q 'DROP SCHEMA' "$CAPTURE"
grep -q 'SELECT 1' "$CAPTURE"
if spool_leaked; then echo 'FAIL: successful restore left the restore spool behind'; exit 1; fi
# A missing spool directory must fail closed, not silently fall back to /tmp.
if OE_RESTORE_SPOOL_DIR="$scratch/missing" oe_pg_restore "$scratch/archive" \
  > "$scratch/missing.log" 2>&1; then
  echo 'FAIL: unusable restore spool directory was accepted'
  exit 1
fi

# A restore interrupted by a signal must not strand the spooled dump. This
# is a behavioral guard, not fail-on-old evidence: bash (verified on 3.2 and
# 5.3) already runs an EXIT trap on TERM, so the pre-review EXIT-only trap
# also passed it; the explicit signal traps must keep it true. The function
# body runs in a subshell, so the signal is aimed at that subshell: the
# producer stub publishes its pid via sh's $PPID, and the wrapper only exits
# after the subshell's trap has run. TERM is used because background jobs
# ignore INT.
export SUB_PID_FILE="$scratch/sub.pid"
cat > "$scratch/interrupted.sh" <<'RUN'
. scripts/cli/backup.sh
oe_prod() {
  case "$*" in
    *pg_restore*)
      sh -c 'echo "$PPID"' > "$SUB_PID_FILE"
      cat >/dev/null
      while :; do sleep 0.05; done ;;
    *) return 99 ;;
  esac
}
oe_pg_restore "$1"
RUN
bash "$scratch/interrupted.sh" "$scratch/archive" \
  > "$scratch/interrupted.log" 2>&1 &
restore_pid=$!
for _ in $(seq 1 200); do
  if [ -s "$SUB_PID_FILE" ]; then
    sub_pid=$(cat "$SUB_PID_FILE")
    break
  fi
  sleep 0.05
done
if [ -z "$sub_pid" ]; then
  echo 'FAIL: interrupted restore never reached the producer'
  exit 1
fi
kill -TERM "$sub_pid"
if wait "$restore_pid"; then echo 'FAIL: interrupted restore reported success'; exit 1; fi
restore_pid=""
sub_pid=""
if spool_leaked; then echo 'FAIL: interrupted restore left the restore spool behind'; exit 1; fi
echo 'ok: failed archives never reach psql; valid SQL is restored transactionally'
