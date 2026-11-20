#!/usr/bin/env bash
# Self-test for ./openexam's shell code, meant to run under the oldest shell
# it supports: CI runs it in the bash:3.2 image (macOS's /bin/bash is 3.2),
# whose busybox sed/awk/grep also catch GNU-only flags.
#
#   ./scripts/test-cli.sh                     # with whatever bash is local
#   docker run --rm -v "$PWD:/w:ro" -w /w bash:3.2 bash scripts/test-cli.sh
#
# Covers what can run without Docker or a terminal: syntax of every file,
# the env-file reader/writer, placeholder detection, validators, and the
# non-interactive behavior of every prompt (defaults, never hanging).
set -euo pipefail
cd "$(dirname "$0")/.."

fails=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() {
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

echo "bash $BASH_VERSION"

for f in openexam scripts/lib/*.sh scripts/cli/*.sh scripts/offsite.sh scripts/install-cron.sh \
  scripts/create-cap-site-key.sh scripts/install-docker.sh; do
  check "syntax: $f" bash -n "$f"
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export OE_LOG="$tmp/log"
# shellcheck source=scripts/lib/ui.sh
. scripts/lib/ui.sh
# shellcheck source=scripts/lib/detect.sh
. scripts/lib/detect.sh
# shellcheck source=scripts/lib/env-file.sh
. scripts/lib/env-file.sh
# shellcheck source=scripts/cli/common.sh
. scripts/cli/common.sh

# ── env-file ──
f="$tmp/env"
printf 'A=1\n# B=commented\nQ="quoted value"\nA=duplicate\n' > "$f"
chmod 600 "$f"
env_set A 'two words $HOME' "$f"
env_set B "it's \$x \"q\"" "$f"
env_set C 'plain-value_1.2:3@x' "$f"
env_set Q 'OpenExam <no-reply@a.ch>' "$f"
env_set EMPTY '' "$f"
check "env_get single-quoted" [ "$(env_get A "$f")" = 'two words $HOME' ]
check "env_get bare" [ "$(env_get C "$f")" = 'plain-value_1.2:3@x' ]
check "env_get replaced quoted" [ "$(env_get Q "$f")" = 'OpenExam <no-reply@a.ch>' ]
check "env_get empty" [ -z "$(env_get EMPTY "$f")" ]
check "env_get missing" [ -z "$(env_get NOPE "$f")" ]
check "env_set drops duplicates" [ "$(grep -c '^A=' "$f")" -eq 1 ]
check "env_set keeps comments" grep -q '^# B=commented$' "$f"
perms=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
check "env_set keeps mode 600" [ "$perms" = 600 ]
# shellcheck disable=SC1090 # a generated temp file
(set -a; . "$f"; set +a; [ "$A" = 'two words $HOME' ] && [ "$B" = "it's \$x \"q\"" ]) \
  && pass "values survive bash source" || fail "values survive bash source"

# ── placeholder rule (mirrors lib/env.ts PLACEHOLDER_RE) ──
for v in '' change-me changeme CHANGE_ME sk-change-me your-secret example placeholder todo dummy; do
  check "placeholder: '$v'" env_is_placeholder "$v"
done
for v in real-secret-value sk-abc123 example.com; do
  if env_is_placeholder "$v"; then fail "not a placeholder: '$v'"; else pass "not a placeholder: '$v'"; fi
done

# ── validators ──
check "domain ok" oe_valid_domain exam.example-school.ch
for v in https://x.ch x localhost 'a b.ch' exam.ch/path; do
  if oe_valid_domain "$v" >/dev/null; then fail "domain rejects '$v'"; else pass "domain rejects '$v'"; fi
done
check "email ok" oe_valid_email a.b@example-school.ch
if oe_valid_email nope >/dev/null; then fail "email rejects 'nope'"; else pass "email rejects 'nope'"; fi
check "tenant GUID ok" oe_valid_tenant 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b
if oe_valid_tenant common >/dev/null; then fail "tenant rejects common"; else pass "tenant rejects common"; fi
# Mirrors __tests__/school-domains.test.ts (schoolDomainsIssue).
check "school domains ok" oe_school_domains_issue stud.example-school.ch " Example-School.ch , @staff.example.org"
check "school domains: one list empty" oe_school_domains_issue "" example-school.ch
check "school domains: empty entries skipped" oe_school_domains_issue "a.ch,,b.ch," c.ch
for pair in "not a domain|" "x|" "https://a.ch|" "a.ch|a.ch" "A.ch|@a.CH" "a.ch,b.ch|c.ch, b.ch"; do
  if oe_school_domains_issue "${pair%%|*}" "${pair#*|}" >/dev/null; then
    fail "school domains reject '$pair'"
  else
    pass "school domains reject '$pair'"
  fi
done
check "school domains message" [ "$(oe_school_domains_issue a.ch A.CH || true)" = '"a.ch" is listed in both SCHOOL_STUDENT_DOMAINS and SCHOOL_TEACHER_DOMAINS' ]
check "port ok" oe_valid_port 587
if oe_valid_port 70000 >/dev/null; then fail "port rejects 70000"; else pass "port rejects 70000"; fi

# ── prompts without a terminal take their defaults ──
ans=""
ui_ask ans "Question" "the-default" </dev/null >/dev/null
check "ui_ask default" [ "$ans" = the-default ]
ui_ask_optional ans "Optional" "" </dev/null >/dev/null
check "ui_ask_optional empty" [ -z "$ans" ]
ui_select ans "Menu" 1 "a|A|first" "b|B|second" </dev/null >/dev/null
check "ui_select default index" [ "$ans" = b ]
if ui_confirm "Yes default" y </dev/null >/dev/null; then pass "ui_confirm y default"; else fail "ui_confirm y default"; fi
if ui_confirm "No default" n </dev/null >/dev/null; then fail "ui_confirm n default"; else pass "ui_confirm n default"; fi
if (ui_ask ans "Required" "" "" "--flag" </dev/null >/dev/null 2>&1); then
  fail "ui_ask without default exits"
else
  pass "ui_ask without default exits"
fi
if (ui_type_to_confirm exam.ch "Destroy" </dev/null >/dev/null 2>&1); then
  fail "typed confirmation refuses unattended"
else
  pass "typed confirmation refuses unattended"
fi
(OE_CONFIRM=exam.ch ui_type_to_confirm exam.ch "Destroy" </dev/null >/dev/null 2>&1) \
  && pass "typed confirmation accepts OE_CONFIRM" || fail "typed confirmation accepts OE_CONFIRM"

# ── ui_run ──
ui_run "true succeeds" true >/dev/null && pass "ui_run success" || fail "ui_run success"
if ui_run "false fails" false >/dev/null 2>&1; then fail "ui_run failure status"; else pass "ui_run failure status"; fi

# ── secrets ──
s=$(oe_secret_alnum 24)
check "alnum secret length" [ "${#s}" -eq 24 ]
check "alnum secret charset" sh -c "printf '%s' '$s' | grep -Eq '^[A-Za-z0-9]+$'"

# ── legal pages (LEGAL_*, mirrors deploy.sh / lib/env.ts) ──
check "legal email ok" oe_valid_legal_email datenschutz@example-school.ch
if oe_valid_legal_email "a@b" >/dev/null; then fail "legal email rejects 'a@b'"; else pass "legal email rejects 'a@b'"; fi
if oe_valid_legal_text example >/dev/null; then fail "legal text rejects 'example'"; else pass "legal text rejects 'example'"; fi
lf="$tmp/legal.env"
printf 'LEGAL_CONTROLLER_NAME=example\nLEGAL_CONTACT_EMAIL=nope\nLEGAL_HOSTING_PROVIDER=Hetzner\n' > "$lf"
check "legal missing lists bad keys" [ "$(oe_legal_missing "$lf" | tr '\n' ' ')" = "LEGAL_CONTROLLER_NAME LEGAL_CONTROLLER_ADDRESS LEGAL_CONTACT_EMAIL " ]
(
  PROD_ENV="$lf"
  LEGAL_CONTROLLER_NAME="Kantonsschule Musterstadt"
  LEGAL_CONTROLLER_ADDRESS='Musterstrasse 1\n8000 Zürich'
  LEGAL_CONTACT_EMAIL=""
  LEGAL_HOSTING_PROVIDER="Hetzner Online GmbH (DE)"
  oe_ask_legal "admin@example-school.ch" </dev/null >/dev/null
  oe_write_legal
)
check "legal values written" [ -z "$(oe_legal_missing "$lf")" ]
check "legal address keeps literal \\n" [ "$(env_get LEGAL_CONTROLLER_ADDRESS "$lf")" = 'Musterstrasse 1\n8000 Zürich' ]
check "legal contact defaults to admin email" [ "$(env_get LEGAL_CONTACT_EMAIL "$lf")" = admin@example-school.ch ]
if (LEGAL_CONTROLLER_NAME="" oe_ask_legal "a@example-school.ch" </dev/null >/dev/null 2>&1); then
  fail "legal ask without values exits"
else
  pass "legal ask without values exits"
fi

# ── install local: repairing a .env copied from .env.example ──
# shellcheck source=scripts/cli/local.sh
. scripts/cli/local.sh
cp .env.example "$tmp/dev.env"
DEV_ENV="$tmp/dev.env"
oe_repair_dev_env >/dev/null
check "repair adds DATABASE_URL" [ "$(env_get DATABASE_URL "$DEV_ENV")" = postgresql://openexam:openexam@localhost:5432/openexam ]
check "repair adds the dev WS URL" [ "$(env_get NEXT_PUBLIC_WS_URL "$DEV_ENV")" = ws://localhost:8080 ]
check "repair replaces the example origin" [ "$(env_get NEXT_PUBLIC_BASE_URL "$DEV_ENV")" = http://localhost:3000 ]
check "repair replaces example ALLOWED_ORIGINS" [ "$(env_get ALLOWED_ORIGINS "$DEV_ENV")" = http://localhost:3000 ]
check "repair clears the placeholder POSTGRES_PASSWORD" [ -z "$(env_get POSTGRES_PASSWORD "$DEV_ENV")" ]
for k in BETTER_AUTH_SECRET MATCHING_ID_SECRET TEACHER_ACCESS_CODE AT_REST_ENC_KEY CAP_SECRET_KEY; do
  if env_is_placeholder "$(env_get "$k" "$DEV_ENV")"; then fail "repair fills $k"; else pass "repair fills $k"; fi
done
before=$(cat "$DEV_ENV")
oe_repair_dev_env >/dev/null
check "repair is idempotent" [ "$before" = "$(cat "$DEV_ENV")" ]
DEV_ENV=.env

# ── optional SMTP on unattended production installs ──
# shellcheck source=scripts/cli/install.sh
. scripts/cli/install.sh
(
  unset SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM SMTP_SECURE
  OE_ASSUME_YES=1
  oe_ask_smtp </dev/null >/dev/null
  [ "$SMTP_ENABLED" -eq 0 ]
) && pass "unattended install skips unconfigured SMTP" || fail "unattended install skips unconfigured SMTP"
(
  unset SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM SMTP_SECURE
  OE_ASSUME_YES=0
  oe_ask_smtp </dev/null >/dev/null
  [ "$SMTP_ENABLED" -eq 0 ]
) && pass "nonterminal install skips unconfigured SMTP" || fail "nonterminal install skips unconfigured SMTP"
(
  OE_ASSUME_YES=1
  DOMAIN=exam.school.ch
  SMTP_HOST=smtp.school.ch SMTP_PORT=465 SMTP_USER=test-user SMTP_PASSWORD=test-password
  SMTP_FROM='OpenExam <test@school.ch>'
  oe_ask_smtp </dev/null >/dev/null
  [ "$SMTP_ENABLED" -eq 1 ] && [ "$SMTP_SECURE" = true ] && [ "$SMTP_USER" = test-user ] && [ "$SMTP_PASSWORD" = test-password ]
) && pass "unattended install keeps configured SMTP" || fail "unattended install keeps configured SMTP"

# ── monitoring setup: private config and an initially absent crontab ──
# Production monitoring is Linux-only; local CLI checks also run on macOS.
if [ "$(oe_os)" = linux ]; then
  fixture="$tmp/monitoring"
  mkdir -p "$fixture/scripts/lib" "$fixture/monitoring/alertmanager" "$fixture/bin"
  cp scripts/setup-monitoring.sh "$fixture/scripts/"
  cp scripts/lib/production-compose.sh scripts/lib/env-file.sh scripts/lib/pitr-state.sh scripts/lib/detect.sh "$fixture/scripts/lib/"
  cp monitoring/alertmanager/alertmanager.yml.tmpl "$fixture/monitoring/alertmanager/"
  cat > "$fixture/.env.prod" <<'ENV'
WALG_STORAGE_BACKEND=disabled
GRAFANA_ADMIN_PASSWORD=fixture-password
GLITCHTIP_SECRET_KEY=fixture-secret
GLITCHTIP_DB_PASSWORD=fixture-password
MONITORING_DB_PASSWORD=fixture-password
ALERT_EMAIL_TO=test@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_FROM=test@example.com
SMTP_USER=test
SMTP_PASSWORD=fixture-password
SMTP_SECURE=false
NEXT_PUBLIC_CAP_WIDGET_ENDPOINT=/cap-api/abcdef1234/
ENV
  cat > "$fixture/bin/docker" <<'MOCK'
#!/bin/sh
printf '%s\n' "$ALERTMANAGER_CONFIG_GID" > "$FIXTURE_DOCKER_LOG"
MOCK
  cat > "$fixture/bin/crontab" <<'MOCK'
#!/bin/sh
if [ "$1" = -l ]; then
  [ -f "$FIXTURE_CRONTAB" ] || exit 1
  cat "$FIXTURE_CRONTAB"
else
  cat > "$FIXTURE_CRONTAB.new"
  mv "$FIXTURE_CRONTAB.new" "$FIXTURE_CRONTAB"
fi
MOCK
  chmod +x "$fixture/bin/docker" "$fixture/bin/crontab"
  run_monitoring_fixture() {
    PATH="$fixture/bin:$PATH" FIXTURE_DOCKER_LOG="$fixture/docker-gid" FIXTURE_CRONTAB="$fixture/crontab" \
      "$BASH" "$fixture/scripts/setup-monitoring.sh" > "$fixture/setup.log" 2>&1
  }
  check "monitoring setup handles absent crontab" run_monitoring_fixture
  am_config="$fixture/monitoring/alertmanager/alertmanager.yml"
  check "monitoring config is mode 640" [ "$(stat -c %a "$am_config")" = 640 ]
  check "monitoring config group is persisted" [ "$(env_get ALERTMANAGER_CONFIG_GID "$fixture/.env.prod")" = "$(stat -c %g "$am_config")" ]
  check "compose receives monitoring config group" [ "$(cat "$fixture/docker-gid")" = "$(stat -c %g "$am_config")" ]
  check "monitoring config renders SMTP values" grep -q 'smtp_auth_password: "fixture-password"' "$am_config"
  check "monitoring installs both cron jobs" [ "$(wc -l < "$fixture/crontab" | tr -d ' ')" = 2 ]
  am_inode=$(stat -c %i "$am_config")
  check "monitoring setup reruns successfully" run_monitoring_fixture
  check "monitoring cron jobs are not duplicated" [ "$(wc -l < "$fixture/crontab" | tr -d ' ')" = 2 ]
  # Re-runs rewrite the config in place: a replaced file would change the
  # bind mount's inode (stale config until recreate) and its group.
  check "monitoring rerun keeps the config inode" [ "$(stat -c %i "$am_config")" = "$am_inode" ]
  # The rendered config holds SMTP_PASSWORD and is group-readable: its group
  # must not be shared with other user accounts (setup-monitoring.sh's
  # contract), whether that is the dedicated openexam-monitoring group or a
  # user-private fallback.
  check "monitoring config group is not shared with other users" \
    oe_group_private_to "$(stat -c %g "$am_config")" "$(id -un)"
  if [ -n "$(oe_group_gid openexam-monitoring)" ]; then
    check "monitoring config uses the dedicated group" \
      [ "$(stat -c %g "$am_config")" = "$(oe_group_gid openexam-monitoring)" ]
  fi
fi
# ── transactional restore command boundary ──
check "restore rejects partial archive output" bash scripts/test-restore.sh
check "historical restore refuses destructive execution" bash scripts/test-pitr-restore.sh

# ── entrypoint ──
check "help exits 0" sh -c './openexam help >/dev/null'
check "subcommand help exits 0" sh -c './openexam install local --help >/dev/null && ./openexam doctor --help >/dev/null'
code=0; ./openexam no-such-command >/dev/null 2>&1 || code=$?
check "unknown command exits 2" [ "$code" -eq 2 ]

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
