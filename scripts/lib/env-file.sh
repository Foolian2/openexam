# shellcheck shell=bash
# Read and write KEY=value lines in .env / .env.prod without sed -i (whose
# flags differ between GNU and BSD/macOS) and without letting a value's
# characters break the substitution: awk gets both key and value through the
# environment, so nothing in them is interpreted.
#
# Values are written so docker compose's --env-file parser, Next.js' dotenv
# and bash's `source` (scripts/setup-monitoring.sh) all read them back
# identically: bare when they're plain, single-quoted (literal everywhere —
# compose doesn't interpolate inside single quotes) otherwise.

# env_get KEY FILE — prints the value of the last uncommented KEY= line,
# without surrounding quotes. Empty (and status 0) when unset.
env_get() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1) || true
  value="${line#*=}"
  case "$value" in
    \"*\")
      value="${value#\"}"; value="${value%\"}"
      # Undo env_quote's escaping: \\ \" \$ \` back to the bare character.
      value=$(printf '%s' "$value" | sed -e 's/\\\([\\"$`]\)/\1/g')
      ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# env_quote VALUE — the value as it should appear right of the '='.
env_quote() {
  local value="$1"
  case "$value" in
    *$'\n'*) echo "env_quote: multi-line values are not supported" >&2; return 1 ;;
  esac
  if [ -z "$value" ] || printf '%s' "$value" | grep -Eq '^[A-Za-z0-9_./:@+=,%-]+$'; then
    printf '%s' "$value"
  elif [ "${value#*\'}" = "$value" ]; then
    printf "'%s'" "$value"
  else
    # Contains a single quote: double quotes, escaping what compose/dotenv/bash
    # would otherwise interpret inside them.
    # shellcheck disable=SC2016 # the $ and ` are literal sed patterns
    value=$(printf '%s' "$value" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g' -e 's/`/\\`/g')
    printf '"%s"' "$value"
  fi
}

# env_set KEY VALUE FILE — replaces the uncommented KEY= line (the first one;
# later duplicates are dropped) or appends one. Keeps the file's mode and
# inode, so a chmod 600 .env.prod stays 600.
env_set() {
  local key="$1" value="$2" file="$3" quoted tmp
  quoted=$(env_quote "$value") || return 1
  tmp=$(mktemp "${file}.XXXXXX") || return 1
  OE_KEY="$key" OE_LINE="$key=$quoted" awk '
    BEGIN { key = ENVIRON["OE_KEY"]; line = ENVIRON["OE_LINE"]; done = 0 }
    index($0, key "=") == 1 { if (!done) { print line; done = 1 } ; next }
    { print }
    END { if (!done) print line }
  ' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# env_is_placeholder VALUE — same rule as PLACEHOLDER_RE in lib/env.ts (plus
# empty), so doctor and the app's boot check agree on what "unset" means.
env_is_placeholder() {
  [ -z "$1" ] && return 0
  printf '%s\n' "$1" | grep -Eiq '^(sk[-_]?)?(change[-_]?me|changeme|your[-_][a-z0-9-]+|example|placeholder|todo|dummy)$'
}
