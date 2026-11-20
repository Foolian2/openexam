# shellcheck shell=bash
# Host auto-detection for ./openexam. Every function prints its answer (or
# returns a status) and never prompts — the wizard decides what to do with it.
# bash 3.2 compatible and Linux + macOS aware (see scripts/lib/ui.sh).

oe_has() { command -v "$1" >/dev/null 2>&1; }

# linux | macos | other
oe_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo macos ;;
    *) echo other ;;
  esac
}

# Distribution ID from /etc/os-release (ubuntu, debian, …), empty elsewhere.
oe_distro() {
  [ -r /etc/os-release ] || return 0
  # shellcheck disable=SC1091
  (. /etc/os-release && printf '%s' "${ID:-}")
}

oe_distro_pretty() {
  if [ "$(oe_os)" = macos ]; then
    printf 'macOS %s' "$(sw_vers -productVersion 2>/dev/null || echo '?')"
  elif [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    (. /etc/os-release && printf '%s' "${PRETTY_NAME:-${ID:-Linux}}")
  else
    uname -sr
  fi
}

oe_is_root() { [ "$(id -u)" -eq 0 ]; }

# Prints "sudo" when commands needing root must be prefixed with it, nothing
# when already root. Returns 1 when neither works.
oe_sudo() {
  if oe_is_root; then
    return 0
  elif oe_has sudo; then
    echo sudo
  else
    return 1
  fi
}

# Numeric group ID of a file, empty when unreadable. GNU stat first,
# BSD/macOS stat as the fallback (the same pattern as scripts/cli/ops.sh
# and scripts/test-cli.sh). Always succeeds — callers check for empty.
oe_file_gid() {
  stat -c %g "$1" 2>/dev/null || stat -f %g "$1" 2>/dev/null || true
}

# GID of a named group, empty when the group does not exist. getent also
# sees NSS sources (LDAP/AD-joined hosts); /etc/group is the fallback for
# the minimal images that carry no getent. Named lookup, not a dump — some
# getent builds (macOS) do not enumerate. Always succeeds like oe_file_gid.
oe_group_gid() {
  local name="$1"
  if oe_has getent; then
    getent group "$name" 2>/dev/null | awk -F: -v n="$name" '$1 == n && !f { print $3; f = 1 }' || true
  else
    awk -F: -v n="$name" '$1 == n && !f { print $3; f = 1 }' /etc/group 2>/dev/null || true
  fi
}

# Succeeds when no login-range account (uid >= 1000, UID_MIN's default)
# except $2 has group $1 as its primary or a supplementary group — i.e. a
# mode-0640 file with that group shares its group-readable contents with no
# other human. System identities (root, sync, daemons) are not the threat
# here; unresolvable member names count as shared. Used to keep the rendered
# Alertmanager config's SMTP_PASSWORD away from shared groups (users, staff,
# AD defaults) on hosts without a user-private primary group.
oe_group_private_to() {
  local gid="$1" user="$2" prog
  prog='
    FNR == NR {
      uid[$1] = $3
      if ($4 == gid && $1 != user && $3 >= 1000) shared = 1
      next
    }
    $3 == gid {
      n = split($4, members, ",")
      for (i = 1; i <= n; i++) {
        m = members[i]
        if (m != "" && m != user && (!(m in uid) || uid[m] >= 1000)) shared = 1
      }
    }
    END { exit shared ? 1 : 0 }
  '
  # Inline process substitution, never x=<(…): bash leaves that fd closed
  # for the following command, so the reader cannot open the /dev/fd path.
  if oe_has getent; then
    awk -F: -v gid="$gid" -v user="$user" "$prog" \
      <(getent passwd 2>/dev/null) <(getent group 2>/dev/null)
  else
    awk -F: -v gid="$gid" -v user="$user" "$prog" /etc/passwd /etc/group
  fi
}

oe_docker_installed() { oe_has docker; }
oe_docker_running() { docker info >/dev/null 2>&1; }
oe_compose_v2() { docker compose version >/dev/null 2>&1; }

oe_docker_version() {
  docker version --format '{{.Server.Version}}' 2>/dev/null || true
}

oe_compose_version() {
  docker compose version --short 2>/dev/null || true
}

# The daemon is up but this user can't reach the socket (not in the docker
# group yet, or the group change needs a new login).
oe_docker_permission_denied() {
  docker info 2>&1 | grep -qi 'permission denied'
}

# Node major version, empty when node isn't installed.
oe_node_major() {
  oe_has node || return 0
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

# Directory of the first Node with at least the given major version, looking
# past whatever node comes first on PATH: every PATH entry, then Homebrew's and
# nvm's installs. Empty when there is none.
oe_find_node_dir() {
  local min="$1" dirs dir major
  # Gather first, then scan: breaking out of a pipe would SIGPIPE the producer
  # and trip pipefail.
  dirs=$(printf '%s\n' "$PATH" | tr ':' '\n')
  if oe_has brew; then dirs="$dirs
$(brew --prefix 2>/dev/null)/opt/node/bin"; fi
  dirs="$dirs
$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null || true)"
  while IFS= read -r dir; do
    [ -n "$dir" ] && [ -x "$dir/node" ] || continue
    major=$("$dir/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
    case "$major" in '' | *[!0-9]*) continue ;; esac
    if [ "$major" -ge "$min" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done <<EOF_DIRS
$dirs
EOF_DIRS
}

# pnpm version pinned in package.json's packageManager field.
oe_pnpm_wanted() {
  sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1
}

oe_pnpm_version() {
  oe_has pnpm || return 0
  pnpm --version 2>/dev/null || true
}

# This host's public IPv4 — same lookups as scripts/check-dns.sh.
oe_public_ip() {
  curl -sf --max-time 10 https://api.ipify.org 2>/dev/null \
    || curl -sf --max-time 10 https://ifconfig.me/ip 2>/dev/null \
    || true
}

# SSH port from sshd_config — same parsing as scripts/configure-firewall.sh.
oe_ssh_port() {
  local port
  port=$(grep -E '^Port ' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1 || true)
  echo "${port:-22}"
}

# Name of the process listening on a TCP port, empty when the port is free.
oe_port_owner() {
  local port="$1" owner
  if oe_has lsof; then
    # lsof exits 1 when nothing listens — that's the "free" answer, not an error.
    { lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR == 2 { print $1 }'
  elif oe_has ss; then
    [ -n "$(ss -ltnH "sport = :$port" 2>/dev/null)" ] || return 0
    # Process names need privileges; without them the socket still shows.
    owner=$( { ss -ltnpH "sport = :$port" 2>/dev/null || true; } | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1)
    echo "${owner:-unknown process}"
  fi
}

oe_mem_mb() {
  if [ "$(oe_os)" = macos ]; then
    echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 ))
  elif [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo
  else
    echo 0
  fi
}

oe_cpus() {
  if [ "$(oe_os)" = macos ]; then
    sysctl -n hw.ncpu 2>/dev/null || echo 0
  else
    getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0
  fi
}

# Free disk space in GB for the filesystem holding $1 (default: cwd).
oe_disk_free_gb() {
  df -Pk "${1:-.}" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024 / 1024) }'
}

# Used-percentage for the filesystem holding $1 (default: cwd).
oe_disk_used_pct() {
  df -Pk "${1:-.}" 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }'
}

oe_git_dirty() { [ -n "$(git status --porcelain 2>/dev/null)" ]; }

# Fractional days until a PEM cert expires (negative when expired), empty
# when the file is missing or unreadable. Works with OpenSSL and LibreSSL.
oe_cert_days_left() {
  local file="$1" end end_s now_s
  [ -r "$file" ] || return 0
  end=$(openssl x509 -in "$file" -noout -enddate 2>/dev/null | cut -d= -f2) || return 0
  [ -n "$end" ] || return 0
  if date -d "$end" +%s >/dev/null 2>&1; then
    end_s=$(date -d "$end" +%s)
  else
    end_s=$(date -j -f '%b %e %T %Y %Z' "$end" +%s 2>/dev/null) || return 0
  fi
  now_s=$(date +%s)
  echo $(( (end_s - now_s) / 86400 ))
}

oe_cert_issuer() {
  openssl x509 -in "$1" -noout -issuer 2>/dev/null | sed 's/^issuer= *//'
}

oe_cert_self_signed() {
  local issuer subject
  issuer=$(openssl x509 -in "$1" -noout -issuer 2>/dev/null | cut -d= -f2-)
  subject=$(openssl x509 -in "$1" -noout -subject 2>/dev/null | cut -d= -f2-)
  [ -n "$issuer" ] && [ "$issuer" = "$subject" ]
}

# Random secrets. LC_ALL=C keeps BSD tr from choking on non-UTF-8 bytes;
# `|| true` because tr dies of SIGPIPE once head has enough, which pipefail
# would otherwise turn into a failed command (and set -e into an exit).
# openssl when present (Linux servers, macOS); /dev/urandom otherwise.
oe_secret_b64() {
  if oe_has openssl; then
    openssl rand -base64 "${1:-32}" | tr -d '\n'
  else
    head -c "${1:-32}" /dev/urandom | base64 | tr -d '\n'
  fi
}
oe_secret_hex() {
  if oe_has openssl; then
    openssl rand -hex "$1"
  else
    od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'
  fi
}
oe_secret_alnum() { { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom || true; } | head -c "$1"; }
