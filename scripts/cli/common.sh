# shellcheck shell=bash
# Helpers shared by the ./openexam subcommands.

# shellcheck disable=SC2034 # used by the subcommand files sourced after this
PROD_ENV=.env.prod
# shellcheck disable=SC2034
DEV_ENV=.env
# shellcheck disable=SC2034
CERT_LIVE=certs/live/openexam

# The same compose invocation the scripts use (scripts/lib/production-compose.sh
# adds the wal-g SFTP overlay when WALG_STORAGE_BACKEND=sftp), plus the
# monitoring profile once setup-monitoring.sh has rendered its config — the
# same rule as scripts/deploy.sh.
oe_prod() {
  local -a COMPOSE
  local walg_backend
  # shellcheck source=scripts/lib/production-compose.sh
  source scripts/lib/production-compose.sh || return 1
  if [ -f monitoring/alertmanager/alertmanager.yml ]; then
    COMPOSE+=(--profile monitoring)
  fi
  "${COMPOSE[@]}" "$@"
}
oe_dev() { docker compose -f docker-compose.yml "$@"; }

oe_require_prod_env() {
  [ -f "$PROD_ENV" ] || ui_die "No $PROD_ENV here — run ./openexam install first."
}

oe_domain() { env_get DOMAIN "$PROD_ENV"; }

# Runs a command as root: directly when we are root, via sudo otherwise.
oe_as_root() {
  if oe_is_root; then
    "$@"
  elif oe_has sudo; then
    sudo "$@"
  else
    ui_die "Need root for: $* (no sudo available)"
  fi
}

# Runs one of the repo's TypeScript scripts inside the migrate image, the
# way scripts/seed-demo.ts documents: bind-mounted read-only so the deployed
# images stay untouched. Extra `-e NAME` flags go before `--`.
#   oe_prod_tsx [-e VAR ...] -- scripts/foo.ts args...
oe_prod_tsx() {
  local -a envs
  envs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    envs+=("$1")
    shift
  done
  shift
  local script="$1"
  shift
  oe_prod run --rm --no-deps -T \
    -v "$PWD/$script:/app/$script:ro" \
    ${envs[@]+"${envs[@]}"} \
    migrate pnpm tsx "$script" "$@"
}

# Validators for ui_ask: print the reason and return 1 when invalid.
oe_valid_domain() {
  if printf '%s\n' "$1" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$'; then
    return 0
  fi
  echo "Enter a bare domain like exam.example.ch (no https://, no path)."
  return 1
}

oe_valid_email() {
  if printf '%s\n' "$1" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
    return 0
  fi
  echo "That doesn't look like an email address."
  return 1
}

oe_valid_port() {
  case "$1" in
    '' | *[!0-9]*) echo "Enter a port number." ; return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] && return 0
  echo "Ports go from 1 to 65535."
  return 1
}

# Mirrors microsoftTenantIssue in lib/env.ts: a pinned tenant GUID, never
# common/organizations/consumers.
oe_valid_tenant() {
  if printf '%s\n' "$1" | grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    return 0
  fi
  echo "The tenant must be your school's Entra tenant GUID (not common/organizations/consumers)."
  return 1
}

oe_valid_name() {
  [ "${#1}" -ge 2 ] && return 0
  echo "At least 2 characters."
  return 1
}

# Shows where a newly created file lives and that it's secret.
oe_secret_file_note() {
  ui_dim "$1 is chmod 600 and gitignored — it holds secrets."
}

# Waits until `docker info` works, up to $1 seconds (default 90).
oe_wait_for_docker() {
  local limit="${1:-90}" waited=0
  while ! oe_docker_running; do
    [ "$waited" -ge "$limit" ] && return 1
    sleep 2
    waited=$((waited + 2))
  done
}

# ── Datenschutzerklärung & Impressum (LEGAL_*) ──────────────────────────────
# The web tier refuses to boot without these (lib/env.ts) and deploy.sh
# checks them before building, with the same rules as below.
OE_LEGAL_REQUIRED="LEGAL_CONTROLLER_NAME LEGAL_CONTROLLER_ADDRESS LEGAL_CONTACT_EMAIL LEGAL_HOSTING_PROVIDER"

# zod's email regex (z.string().email()), as in scripts/deploy.sh.
oe_valid_legal_email() {
  if printf '%s\n' "$1" | grep -Eq "^([A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$"; then
    return 0
  fi
  echo "That doesn't look like an email address."
  return 1
}

oe_valid_legal_text() {
  if env_is_placeholder "$1"; then
    echo "Enter the real value (placeholders like 'example' or 'changeme' are rejected)."
    return 1
  fi
  return 0
}

# Prints the LEGAL_* keys in $1 (an env file) that are missing or invalid.
oe_legal_missing() {
  local file="$1" key value
  for key in $OE_LEGAL_REQUIRED; do
    value=$(env_get "$key" "$file")
    if env_is_placeholder "$value"; then
      printf '%s\n' "$key"
    elif [ "$key" = LEGAL_CONTACT_EMAIL ] && ! oe_valid_legal_email "$value" >/dev/null; then
      printf '%s\n' "$key"
    fi
  done
}

# Asks for the school's details shown on /datenschutz and /impressum. Values
# exported as LEGAL_* (or already in .env.prod) are the defaults; unattended
# runs need them exported. $1 = default contact email.
oe_ask_legal() {
  local contact_default="$1" street town
  ui_dim "The school is the data controller: /datenschutz and /impressum name it."
  ui_dim "The wording is a template, not legal advice — have the school's data"
  ui_dim "protection officer review those pages before students use the platform."
  ui_ask LEGAL_CONTROLLER_NAME "School (legal name)" "${LEGAL_CONTROLLER_NAME:-}" oe_valid_legal_text "LEGAL_CONTROLLER_NAME"
  if [ -z "${LEGAL_CONTROLLER_ADDRESS:-}" ] && ui_interactive; then
    ui_ask street "Street and number" "" oe_valid_legal_text
    ui_ask town "Postcode and town" "" oe_valid_legal_text
    # lib/legal/config.ts splits on the two characters \n.
    LEGAL_CONTROLLER_ADDRESS="$street\\n$town"
  else
    ui_ask LEGAL_CONTROLLER_ADDRESS "School address (lines separated by \\n)" "${LEGAL_CONTROLLER_ADDRESS:-}" oe_valid_legal_text "LEGAL_CONTROLLER_ADDRESS"
  fi
  ui_ask LEGAL_CONTACT_EMAIL "Privacy contact email" "${LEGAL_CONTACT_EMAIL:-$contact_default}" oe_valid_legal_email "LEGAL_CONTACT_EMAIL"
  ui_ask LEGAL_HOSTING_PROVIDER "Hosting provider (e.g. Hetzner Online GmbH, Falkenstein (DE))" "${LEGAL_HOSTING_PROVIDER:-}" oe_valid_legal_text "LEGAL_HOSTING_PROVIDER"
  ui_dim "Optional details (phone, data protection officer, retention rules): LEGAL_* in .env.prod."
}

oe_write_legal() {
  local key
  for key in $OE_LEGAL_REQUIRED; do
    env_set "$key" "${!key}" "$PROD_ENV"
  done
}

# For installs from before the legal pages existed: asks for the missing
# values and writes them, so the following deploy.sh doesn't stop on them.
oe_ensure_legal() {
  local missing key
  missing=$(oe_legal_missing "$PROD_ENV")
  [ -n "$missing" ] || return 0
  ui_header "Datenschutzerklärung & Impressum"
  ui_warn "Missing in .env.prod: $(printf '%s' "$missing" | tr '\n' ' ')"
  # Keep the values that are already fine as defaults.
  for key in $OE_LEGAL_REQUIRED; do
    if [ -z "${!key:-}" ] && ! printf '%s\n' "$missing" | grep -qx "$key"; then
      printf -v "$key" '%s' "$(env_get "$key" "$PROD_ENV")"
    fi
  done
  oe_ask_legal "$(env_get ACME_EMAIL "$PROD_ENV")"
  oe_write_legal
  ui_ok "Wrote the legal details to .env.prod"
}
