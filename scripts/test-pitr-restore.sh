#!/usr/bin/env bash
# Refusal regression: no Docker daemon or real archive is required. These
# assertions are what fail against the pre-fix script (master): it accepted
# `--target-time` and fetched LATEST anyway, aborted silently on a missing
# .env.prod before printing any refusal (set -e + pipefail on the compose
# helper's sed), and treated `--target-time=T` as an unknown argument. The
# exit status is 1 in all those cases, so the refusal-message check is
# intentionally the discriminating assertion.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/docker" <<'STUB'
#!/bin/sh
printf 'unexpected Docker call\n' >> "$RESTORE_CALLS"
exit 99
STUB
chmod +x "$scratch/docker"
export RESTORE_CALLS="$scratch/calls"

check_refused() {
  local label="$1"
  shift
  if PATH="$scratch:$PATH" bash scripts/pitr-restore.sh "$@" > "$scratch/output" 2>&1; then
    echo "FAIL: historical restore accepted ($label)"
    exit 1
  fi
  grep -q 'Historical --target-time restore is disabled' "$scratch/output" \
    || { echo "FAIL: no historical-restore refusal ($label)"; sed 's/^/  /' "$scratch/output"; exit 1; }
  [ ! -e "$RESTORE_CALLS" ] \
    || { echo "FAIL: Docker ran before the refusal ($label)"; exit 1; }
}

check_refused 'target-time with --latest' --latest --target-time '2026-08-13 12:00:00+00' --yes-i-am-sure
check_refused 'bare target-time' --target-time '2026-08-13 12:00:00+00' --yes-i-am-sure
check_refused 'empty target-time' --latest --target-time '' --yes-i-am-sure
check_refused 'equals form' --target-time=2026-08-13T12:00:00Z --yes-i-am-sure
check_refused 'equals form with --latest' --latest --target-time=2026-08-13T12:00:00Z --yes-i-am-sure

if PATH="$scratch:$PATH" bash scripts/pitr-restore.sh > "$scratch/output" 2>&1; then
  echo 'FAIL: restore without --latest was accepted'
  exit 1
fi
grep -q -- '--latest is required (historical --target-time restores are disabled)' "$scratch/output" \
  || { echo 'FAIL: no-argument error does not refuse historical targets in its wording'; exit 1; }
[ ! -e "$RESTORE_CALLS" ] || { echo 'FAIL: Docker ran without arguments'; exit 1; }

# Positive path. Every assertion above passes against a script that refuses
# EVERYTHING, including the supported flow, so pin that --latest with the
# confirmation flag clears argument validation and fails later (here: no
# .env.prod) rather than being talked into a historical refusal.
if PATH="$scratch:$PATH" bash scripts/pitr-restore.sh --latest --yes-i-am-sure > "$scratch/positive" 2>&1; then
  echo 'FAIL: --latest unexpectedly succeeded without a real archive'
  exit 1
fi
for wording in 'Historical --target-time restore is disabled' \
  '--latest is required' 'Re-run with --yes-i-am-sure'; do
  if grep -q -- "$wording" "$scratch/positive"; then
    echo "FAIL: --latest was rejected by argument validation ($wording)"
    sed 's/^/  /' "$scratch/positive"
    exit 1
  fi
done
grep -q -- '.env.prod missing' "$scratch/positive" \
  || { echo 'FAIL: --latest did not get as far as the environment check'; sed 's/^/  /' "$scratch/positive"; exit 1; }

echo 'ok: historical restore fails closed before any Docker operation'
echo 'ok: --latest clears argument validation'
