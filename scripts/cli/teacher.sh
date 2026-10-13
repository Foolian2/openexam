# shellcheck shell=bash
# ./openexam create-teacher — wraps scripts/create-teacher.ts

teacher_usage() {
  cat <<EOF
Usage: ./openexam create-teacher [options]

Creates a password login for a teacher or admin, already verified — no
access code, captcha or email round-trip needed. Asks for anything missing.

  --email EMAIL        Login email
  --name NAME          Display name
  --role ROLE          TEACHER or ADMIN (default: ADMIN when asked interactively)
  --reset-password     Set a new password for an existing account instead
  --local              Use the dev database (.env) instead of production

Non-interactive: pass the flags and set TEACHER_PASSWORD in the environment.
EOF
}

# oe_create_teacher MODE EMAIL NAME ROLE [--reset-password]
# MODE is prod or local. The password comes from the exported
# TEACHER_PASSWORD — never an argument, because ui_run writes every command
# line to the install log.
oe_create_teacher() {
  local mode="$1" email="$2" name="$3" role="$4"
  shift 4
  local -a args
  args=(--email "$email" --role "$role" "$@")
  [ -n "$name" ] && args+=(--name "$name")
  if [ "$mode" = local ]; then
    pnpm exec tsx --env-file="$DEV_ENV" scripts/create-teacher.ts "${args[@]}"
  else
    oe_prod_tsx -e TEACHER_PASSWORD -- scripts/create-teacher.ts "${args[@]}"
  fi
}

# Asks for whatever the first-teacher step needs. Sets TEACHER_EMAIL,
# TEACHER_NAME, TEACHER_ROLE and TEACHER_PASSWORD (from the environment when
# already exported there, for --yes runs).
oe_ask_teacher() {
  local default_email="${1:-}" default_role="${2:-ADMIN}" reset="${3:-0}"
  ui_ask TEACHER_EMAIL "Login email" "${TEACHER_EMAIL:-$default_email}" oe_valid_email "--email"
  if [ "$reset" -eq 0 ]; then
    ui_ask TEACHER_NAME "Display name" "${TEACHER_NAME:-}" oe_valid_name "--name"
    if [ -z "${TEACHER_ROLE:-}" ]; then
      ui_select TEACHER_ROLE "Role" "$( [ "$default_role" = ADMIN ] && echo 0 || echo 1 )" \
        "ADMIN|Admin|can promote other teachers and see the audit log" \
        "TEACHER|Teacher|creates and grades exams"
    fi
  fi
  if [ -z "${TEACHER_PASSWORD:-}" ]; then
    ui_secret TEACHER_PASSWORD "Password (min. 12 characters)" 1 12 "TEACHER_PASSWORD"
  fi
  export TEACHER_PASSWORD
}

cmd_create_teacher() {
  local mode=prod reset=0
  TEACHER_EMAIL="${TEACHER_EMAIL:-}" TEACHER_NAME="${TEACHER_NAME:-}" TEACHER_ROLE="${TEACHER_ROLE:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --email) TEACHER_EMAIL="${2:?--email needs a value}"; shift ;;
      --name) TEACHER_NAME="${2:?--name needs a value}"; shift ;;
      --role) TEACHER_ROLE=$(printf '%s' "${2:?--role needs a value}" | tr '[:lower:]' '[:upper:]'); shift ;;
      --reset-password) reset=1 ;;
      --local) mode=local ;;
      -h | --help) teacher_usage; return 0 ;;
      *) ui_die "Unknown option: $1 (see ./openexam create-teacher --help)" ;;
    esac
    shift
  done

  ui_banner "$( [ "$reset" -eq 1 ] && echo "reset a password" || echo "create a teacher account")"
  if [ "$mode" = local ]; then
    [ -f "$DEV_ENV" ] || ui_die "No .env — run ./openexam install local first."
  else
    oe_require_prod_env
    [ -n "$(oe_prod ps -q postgres 2>/dev/null)" ] || ui_die "Postgres isn't running — start the stack first (./scripts/deploy.sh)."
  fi

  oe_ask_teacher "" ADMIN "$reset"
  local -a extra
  extra=()
  [ "$reset" -eq 1 ] && extra=(--reset-password)

  if ui_run "$( [ "$reset" -eq 1 ] && echo "Resetting the password" || echo "Creating $TEACHER_EMAIL")" \
    oe_create_teacher "$mode" "$TEACHER_EMAIL" "$TEACHER_NAME" "${TEACHER_ROLE:-TEACHER}" \
    ${extra[@]+"${extra[@]}"}; then
    ui_dim "$(tail -n 1 "$OE_LOG")"
  else
    exit 1
  fi
}
