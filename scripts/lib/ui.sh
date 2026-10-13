# shellcheck shell=bash
# Terminal UI helpers for ./openexam: colored status lines, prompts, an
# arrow-key menu and a spinner that hides command output in a log file.
#
# Pure bash, no dependencies, and bash 3.2 compatible on purpose: macOS still
# ships 3.2 as /bin/bash, and `./openexam install local` must run there. So:
# no associative arrays, no mapfile, no ${var,,}, no fractional read -t.
#
# Non-interactive mode (stdin/stdout not a TTY, or OE_ASSUME_YES=1 from
# --yes): every prompt takes its default without asking, and a prompt with
# no default fails with a pointer to the flag that supplies it — an
# unattended run must never hang waiting for input nobody will type.

OE_LOG="${OE_LOG:-$PWD/.openexam-install.log}"
OE_ASSUME_YES="${OE_ASSUME_YES:-0}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=; C_BOLD=; C_DIM=; C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=; C_CYAN=
fi

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8* | *utf8* | *UTF8* | *utf-8*)
    SYM_OK="✔"; SYM_FAIL="✖"; SYM_WARN="!"; SYM_ARROW="›"; SYM_DOT="•"
    SPIN_FRAMES="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏" ;;
  *)
    SYM_OK="+"; SYM_FAIL="x"; SYM_WARN="!"; SYM_ARROW=">"; SYM_DOT="*"
    # shellcheck disable=SC1003 # a literal backslash, not an escape
    SPIN_FRAMES='|/-\' ;;
esac

ui_interactive() {
  [ "$OE_ASSUME_YES" != 1 ] && [ -t 0 ] && [ -t 1 ]
}

ui_banner() {
  printf '\n%s%s  OpenExam%s %s%s%s\n' "$C_BOLD" "$C_BLUE" "$C_RESET" "$C_DIM" "${1:-}" "$C_RESET"
  printf '%s  %s%s\n' "$C_DIM" "────────────────────────────────────────────" "$C_RESET"
}

ui_header() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; }
ui_info()   { printf '  %s%s%s %s\n' "$C_CYAN" "$SYM_DOT" "$C_RESET" "$*"; }
ui_ok()     { printf '  %s%s%s %s\n' "$C_GREEN" "$SYM_OK" "$C_RESET" "$*"; }
ui_warn()   { printf '  %s%s%s %s\n' "$C_YELLOW" "$SYM_WARN" "$C_RESET" "$*"; }
ui_err()    { printf '  %s%s%s %s\n' "$C_RED" "$SYM_FAIL" "$C_RESET" "$*" >&2; }
ui_dim()    { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ui_die()    { ui_err "$*"; exit 1; }

# ui_kv "Label" "value" — one aligned row of a summary table.
ui_kv() { printf '    %s%-22s%s %s\n' "$C_DIM" "$1" "$C_RESET" "$2"; }

# ui_ask VAR "Question" [default] [validator] [flag-hint]
# Reads a line into VAR. The validator is a function name; it gets the value
# as $1 and prints a reason (and returns non-zero) when it is unacceptable.
ui_ask() {
  local __var="$1" question="$2" default="${3:-}" validator="${4:-}" hint="${5:-}"
  local answer reason
  if ! ui_interactive; then
    if [ -z "$default" ]; then
      ui_die "$question: no value given${hint:+ (pass $hint)} and no terminal to ask on."
    fi
    if [ -n "$validator" ] && ! reason=$("$validator" "$default"); then
      ui_die "$question: '$default' is not valid — $reason"
    fi
    printf -v "$__var" '%s' "$default"
    return 0
  fi
  while :; do
    if [ -n "$default" ]; then
      printf '  %s?%s %s %s(%s)%s ' "$C_BLUE" "$C_RESET" "$question" "$C_DIM" "$default" "$C_RESET"
    else
      printf '  %s?%s %s ' "$C_BLUE" "$C_RESET" "$question"
    fi
    IFS= read -r answer || exit 1
    [ -n "$answer" ] || answer="$default"
    if [ -z "$answer" ]; then
      ui_warn "A value is required."
      continue
    fi
    if [ -n "$validator" ] && ! reason=$("$validator" "$answer"); then
      ui_warn "$reason"
      continue
    fi
    printf -v "$__var" '%s' "$answer"
    return 0
  done
}

# ui_ask_optional VAR "Question" [default] — like ui_ask, but empty is fine.
ui_ask_optional() {
  local __var="$1" question="$2" default="${3:-}" answer
  if ! ui_interactive; then
    printf -v "$__var" '%s' "$default"
    return 0
  fi
  printf '  %s?%s %s %s(%s)%s ' "$C_BLUE" "$C_RESET" "$question" "$C_DIM" "${default:-empty to skip}" "$C_RESET"
  IFS= read -r answer || exit 1
  [ -n "$answer" ] || answer="$default"
  printf -v "$__var" '%s' "$answer"
}

# ui_secret VAR "Question" [confirm=0] [min-length=0] [env-hint]
# Hidden input. With confirm=1 the value has to be typed twice.
ui_secret() {
  local __var="$1" question="$2" confirm="${3:-0}" minlen="${4:-0}" hint="${5:-}"
  local first second
  if ! ui_interactive; then
    ui_die "$question: no terminal to ask on${hint:+ — set $hint}."
  fi
  while :; do
    printf '  %s?%s %s ' "$C_BLUE" "$C_RESET" "$question"
    IFS= read -rs first || exit 1
    printf '\n'
    if [ "${#first}" -lt "$minlen" ]; then
      ui_warn "At least $minlen characters, please."
      continue
    fi
    if [ "$confirm" = 1 ]; then
      printf '  %s?%s Repeat to confirm: ' "$C_BLUE" "$C_RESET"
      IFS= read -rs second || exit 1
      printf '\n'
      if [ "$first" != "$second" ]; then
        ui_warn "The two entries don't match — try again."
        continue
      fi
    fi
    printf -v "$__var" '%s' "$first"
    return 0
  done
}

# ui_confirm "Question" [default y|n] — returns 0 for yes.
ui_confirm() {
  local question="$1" default="${2:-n}" answer prompt
  if ! ui_interactive; then
    [ "$OE_ASSUME_YES" = 1 ] && [ "$default" = y ] && return 0
    [ "$default" = y ]
    return
  fi
  if [ "$default" = y ]; then prompt="Y/n"; else prompt="y/N"; fi
  while :; do
    printf '  %s?%s %s %s[%s]%s ' "$C_BLUE" "$C_RESET" "$question" "$C_DIM" "$prompt" "$C_RESET"
    IFS= read -r answer || exit 1
    [ -n "$answer" ] || answer="$default"
    case "$answer" in
      y | Y | yes | YES | Yes) return 0 ;;
      n | N | no | NO | No) return 1 ;;
    esac
  done
}

# ui_type_to_confirm "expected" "What this does" — the typed-confirmation
# gate for destructive actions (restore, purge). Never auto-confirmed by
# --yes unless OE_CONFIRM matches, so a stray flag can't wipe a database.
ui_type_to_confirm() {
  local expected="$1" what="$2" answer
  if ! ui_interactive; then
    [ "${OE_CONFIRM:-}" = "$expected" ] && return 0
    ui_err "$what"
    ui_die "This needs a typed confirmation — re-run on a terminal, or set OE_CONFIRM=$expected."
  fi
  printf '  %s%s%s %s\n' "$C_RED" "$SYM_WARN" "$C_RESET" "$what"
  printf '  %s?%s Type %s%s%s to continue: ' "$C_BLUE" "$C_RESET" "$C_BOLD" "$expected" "$C_RESET"
  IFS= read -r answer || exit 1
  [ "$answer" = "$expected" ]
}

# ui_select VAR "Question" default-index "value|Label|description" ...
# Arrow keys (or j/k) + Enter on a terminal; the default otherwise. VAR gets
# the chosen option's value.
ui_select() {
  local __var="$1" question="$2" sel="$3"
  shift 3
  local n=$# i key rest opt label desc
  local -a opts
  opts=("$@")

  if ! ui_interactive; then
    printf -v "$__var" '%s' "${opts[$sel]%%|*}"
    return 0
  fi

  printf '  %s?%s %s %s(↑/↓, Enter)%s\n' "$C_BLUE" "$C_RESET" "$question" "$C_DIM" "$C_RESET"
  printf '\033[?25l'
  # Restore the cursor even when Ctrl-C lands mid-menu.
  trap 'printf "\033[?25h\n"; exit 130' INT
  while :; do
    for ((i = 0; i < n; i++)); do
      opt="${opts[$i]}"
      rest="${opt#*|}"
      label="${rest%%|*}"; desc=""
      [ "$rest" != "$label" ] && desc="${rest#*|}"
      if [ "$i" -eq "$sel" ]; then
        printf '\033[2K    %s%s %s%s' "$C_CYAN" "$SYM_ARROW" "$label" "$C_RESET"
      else
        printf '\033[2K      %s' "$label"
      fi
      [ -n "$desc" ] && printf '  %s%s%s' "$C_DIM" "$desc" "$C_RESET"
      printf '\n'
    done
    IFS= read -rsn1 key || exit 1
    if [ "$key" = $'\033' ]; then
      IFS= read -rsn2 rest || true
      key="$key$rest"
    fi
    case "$key" in
      $'\033[A' | k) sel=$(( (sel + n - 1) % n )) ;;
      $'\033[B' | j) sel=$(( (sel + 1) % n )) ;;
      "") break ;;
      [1-9]) [ "$key" -le "$n" ] && sel=$((key - 1)) ;;
    esac
    printf '\033[%dA' "$n"
  done
  trap - INT
  printf '\033[?25h'
  printf -v "$__var" '%s' "${opts[$sel]%%|*}"
}

# ui_run "Label" command [args...]
# Runs the command with its output appended to $OE_LOG and a spinner in its
# place. On failure, prints the tail of the output and returns its status.
ui_run() {
  local label="$1"
  shift
  local status=0 pid i=0 nframes start_line

  printf '\n=== %s — %s\n$ %s\n' "$(date '+%F %T')" "$label" "$*" >> "$OE_LOG"
  start_line=$(wc -l < "$OE_LOG")

  if [ ! -t 1 ]; then
    printf '  %s %s...\n' "$SYM_DOT" "$label"
    "$@" >> "$OE_LOG" 2>&1 || status=$?
  else
    "$@" >> "$OE_LOG" 2>&1 < /dev/null &
    pid=$!
    nframes=${#SPIN_FRAMES}
    printf '\033[?25l'
    trap 'kill "$pid" 2>/dev/null; printf "\r\033[2K\033[?25h"; exit 130' INT
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s' "$C_CYAN" "${SPIN_FRAMES:$((i % nframes)):1}" "$C_RESET" "$label"
      i=$((i + 1))
      # Fractional sleep works with both GNU coreutils and macOS's BSD sleep.
      sleep 0.1
    done
    wait "$pid" || status=$?
    trap - INT
    printf '\r\033[2K\033[?25h'
  fi

  if [ "$status" -eq 0 ]; then
    ui_ok "$label"
  else
    ui_err "$label (exit $status)"
    printf '%s' "$C_DIM"
    tail -n "+$((start_line + 1))" "$OE_LOG" | tail -n 30 | sed 's/^/      /'
    printf '%s' "$C_RESET"
    ui_dim "Full log: $OE_LOG"
  fi
  return "$status"
}
