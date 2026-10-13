# shellcheck shell=bash
# ./openexam install local — development setup on Linux or macOS
# ./openexam dev           — start services and the Next.js dev server

local_usage() {
  cat <<EOF
Usage: ./openexam install local [options]

Sets up everything for local development: checks Docker/Node/pnpm (and
offers to install what's missing), writes .env with fresh dev secrets,
starts Postgres/Valkey/ws-backend/Cap, applies migrations.

  --demo           Seed demo accounts, a class and exams (default: ask)
  --no-demo        Skip demo data
  --captcha        Use the real Cap captcha instead of DISABLE_CAPTCHA
  --reset-env      Back up an existing .env and write a fresh one
  --no-start       Don't offer to start the dev server at the end
  -y, --yes        No prompts (defaults: keep .env, no demo, captcha off)
EOF
}

dev_usage() {
  cat <<EOF
Usage: ./openexam dev [--stop]

Starts the Docker services if they're down, installs dependencies when the
lockfile changed, applies pending migrations, then runs pnpm dev.
Ctrl-C stops Next.js; the containers keep running for a fast restart.

  --stop     Stop the dev containers instead (data is kept)
EOF
}

# ── prerequisites ───────────────────────────────────────────────────────────

# Asks for the sudo password up front, so it isn't swallowed by a spinner.
oe_sudo_prime() {
  oe_is_root && return 0
  oe_has sudo || ui_die "This step needs root and sudo isn't available."
  ui_info "This step needs administrator rights."
  sudo -v
}

# Homebrew lives outside the default PATH on Apple Silicon until the shell
# profile is updated — pick it up from the standard prefixes.
oe_mac_load_brew() {
  oe_has brew && return 0
  local prefix
  for prefix in /opt/homebrew /usr/local; do
    if [ -x "$prefix/bin/brew" ]; then
      eval "$("$prefix/bin/brew" shellenv)"
      return 0
    fi
  done
  return 1
}

oe_mac_ensure_brew() {
  oe_mac_load_brew && return 0
  ui_warn "Homebrew is not installed. It's the easiest way to get Docker and Node on macOS."
  if ! ui_confirm "Install Homebrew now (official installer from brew.sh)?" y; then
    return 1
  fi
  # Interactive on purpose: the installer asks for the password and confirms.
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  oe_mac_load_brew || ui_die "Homebrew installed, but brew isn't on PATH — open a new terminal and re-run."
}

oe_mac_manual_docker() {
  ui_info "Install one of these, start it, then re-run ./openexam install local:"
  ui_dim "Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/"
  ui_dim "OrbStack:       https://orbstack.dev"
  ui_dim "Colima:         brew install colima docker docker-compose && colima start"
  exit 1
}

# Brew's docker-compose is a CLI plugin, but the docker CLI only finds it if
# ~/.docker/config.json lists brew's plugin directory.
oe_mac_link_compose_plugin() {
  local plugin_dir config="$HOME/.docker/config.json"
  plugin_dir="$(brew --prefix)/lib/docker/cli-plugins"
  oe_compose_v2 && return 0
  mkdir -p "$HOME/.docker"
  if [ ! -s "$config" ]; then
    printf '{\n  "cliPluginsExtraDirs": ["%s"]\n}\n' "$plugin_dir" > "$config"
  elif ! grep -q cliPluginsExtraDirs "$config"; then
    ui_warn "Add this to $config so 'docker compose' works:"
    ui_dim "\"cliPluginsExtraDirs\": [\"$plugin_dir\"]"
  fi
}

oe_mac_install_docker() {
  oe_mac_ensure_brew || oe_mac_manual_docker
  local choice
  ui_select choice "How do you want to run Docker?" 0 \
    "desktop|Docker Desktop|the official app (free for personal/education use)" \
    "colima|Colima|lightweight, command-line only, no GUI" \
    "manual|I'll install it myself|OrbStack, Rancher Desktop, …"
  case "$choice" in
    desktop)
      ui_info "Running: brew install --cask docker"
      brew install --cask docker
      ui_info "Starting Docker Desktop — accept its first-run dialog if it shows one."
      open -a Docker
      ;;
    colima)
      ui_info "Running: brew install colima docker docker-compose"
      brew install colima docker docker-compose
      oe_mac_link_compose_plugin
      ui_run "Starting Colima (2 CPUs, 4 GB RAM)" colima start --cpu 2 --memory 4
      ;;
    manual) oe_mac_manual_docker ;;
  esac
}

oe_mac_start_docker() {
  if oe_has colima && ! [ -d /Applications/Docker.app ]; then
    ui_confirm "Docker isn't running. Start Colima?" y || return 1
    ui_run "Starting Colima" colima start
  elif [ -d /Applications/Docker.app ]; then
    ui_confirm "Docker Desktop isn't running. Start it?" y || return 1
    open -a Docker
  elif [ -d /Applications/OrbStack.app ]; then
    ui_confirm "OrbStack isn't running. Start it?" y || return 1
    open -a OrbStack
  else
    return 1
  fi
}

oe_linux_install_docker() {
  case "$(oe_distro)" in
    ubuntu | debian)
      ui_confirm "Install Docker Engine + Compose from Docker's official apt repository?" y \
        || ui_die "Docker is required. See https://docs.docker.com/engine/install/"
      oe_sudo_prime
      ui_run "Installing Docker (a few minutes)" oe_as_root ./scripts/install-docker.sh --yes \
        || ui_die "Docker installation failed."
      ;;
    *)
      ui_die "Install Docker for $(oe_distro_pretty): https://docs.docker.com/engine/install/ — then re-run."
      ;;
  esac
}

oe_ensure_docker() {
  local os
  os=$(oe_os)
  if ! oe_docker_installed; then
    ui_warn "Docker is not installed."
    if [ "$os" = macos ]; then oe_mac_install_docker; else oe_linux_install_docker; fi
  fi

  if ! oe_docker_running; then
    if oe_docker_permission_denied; then
      ui_err "Docker is running, but $(id -un) may not use it."
      ui_dim "Fix: sudo usermod -aG docker $(id -un), then log out and back in (or run: newgrp docker)."
      exit 1
    fi
    if [ "$os" = macos ]; then
      oe_mac_start_docker || ui_die "Start Docker, then re-run."
    else
      ui_confirm "The Docker daemon isn't running. Start it (systemctl start docker)?" y \
        || ui_die "Start Docker, then re-run."
      oe_sudo_prime
      oe_as_root systemctl start docker
    fi
    ui_info "Waiting for Docker to come up..."
    oe_wait_for_docker 120 || ui_die "Docker didn't come up within 2 minutes."
  fi

  oe_compose_v2 || ui_die "Docker Compose v2 ('docker compose') is missing — install the compose plugin."
  ui_ok "Docker $(oe_docker_version), Compose $(oe_compose_version)"
}

oe_node_ok() {
  local major
  major=$(oe_node_major)
  [ -n "$major" ] && [ "$major" -ge 26 ]
}

# An old node first on PATH (a stray symlink in ~/.local/bin, a tool's bundled
# copy) can hide a Node 26 that is already installed. Put that one first for
# the rest of this run instead of asking to install yet another.
oe_prefer_node() {
  local dir
  dir=$(oe_find_node_dir 26)
  [ -n "$dir" ] || return 1
  PATH="$dir:$PATH"
  export PATH
  hash -r
}

# Explain how to stop $1 (the old node) shadowing the one now in use.
oe_node_shadow_hint() {
  ui_warn "$1 ($("$1" --version 2>/dev/null || echo "?")) shadows it on PATH — using $(command -v node) for this run."
  ui_dim "To fix your shell too, remove $1 or put $(dirname "$(command -v node)") before $(dirname "$1") in PATH."
}

oe_ensure_node() {
  local major shadow
  if oe_node_ok; then
    ui_ok "Node $(node --version)"
    return 0
  fi
  shadow=$(command -v node || true)
  if oe_prefer_node; then
    ui_ok "Node $(node --version)"
    [ -n "$shadow" ] && oe_node_shadow_hint "$shadow"
    return 0
  fi
  major=$(oe_node_major)
  if [ -n "$major" ]; then
    ui_warn "Node $(node --version) is too old — OpenExam needs Node 26 or newer."
  else
    ui_warn "Node.js is not installed."
  fi
  if [ "$(oe_os)" = macos ] && oe_mac_ensure_brew \
    && ui_confirm "Install Node with Homebrew?" y; then
    if brew list --formula node >/dev/null 2>&1; then
      ui_info "Running: brew upgrade node"
      brew upgrade node || brew install node
    else
      ui_info "Running: brew install node"
      brew install node
    fi
    hash -r
    if oe_node_ok || oe_prefer_node; then
      ui_ok "Node $(node --version)"
      [ -n "$shadow" ] && [ "$shadow" != "$(command -v node)" ] && oe_node_shadow_hint "$shadow"
      return 0
    fi
    ui_warn "Homebrew's Node still isn't 26 or newer."
  fi
  ui_info "Install Node 26 with a version manager, then re-run:"
  ui_dim "fnm:  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 26"
  ui_dim "nvm:  https://github.com/nvm-sh/nvm#installing-and-updating, then nvm install 26"
  exit 1
}

oe_ensure_pnpm() {
  local wanted
  wanted=$(oe_pnpm_wanted)
  if oe_has pnpm; then
    # pnpm switches itself to the packageManager version on first use.
    ui_ok "pnpm $(oe_pnpm_version) (project pins ${wanted:-?})"
    return 0
  fi
  ui_warn "pnpm is not installed."
  if oe_has corepack && corepack enable pnpm >/dev/null 2>&1; then
    :
  elif ui_confirm "Install pnpm@${wanted} globally with npm?" y; then
    ui_run "Installing pnpm" npm install -g "pnpm@${wanted}" \
      || ui_run "Installing pnpm (with sudo)" oe_as_root npm install -g "pnpm@${wanted}" \
      || ui_die "Couldn't install pnpm — see https://pnpm.io/installation"
  else
    ui_die "pnpm is required: https://pnpm.io/installation"
  fi
  hash -r
  oe_has pnpm || ui_die "pnpm still isn't on PATH — open a new terminal and re-run."
  ui_ok "pnpm $(oe_pnpm_version)"
}

# Warns about dev ports already taken by something other than this stack.
oe_check_dev_ports() {
  local port owner busy=0
  for port in 3000 5432 6379 8080 8090; do
    owner=$(oe_port_owner "$port")
    [ -n "$owner" ] || continue
    case "$owner" in
      docker* | com.docke* | vpnkit* | colima* | limactl* | OrbStack* | ssh) continue ;;
    esac
    ui_warn "Port $port is in use by $owner — the matching service may fail to start."
    busy=1
  done
  [ "$busy" -eq 0 ] && ui_ok "Ports 3000, 5432, 6379, 8080, 8090 available"
  return 0
}

# ── .env ────────────────────────────────────────────────────────────────────

oe_write_dev_env() {
  local captcha="$1"
  (umask 077 && cat > "$DEV_ENV" <<EOF
# Development environment — written by ./openexam install local.
# Matches docker-compose.yml (everything on 127.0.0.1). Production uses
# .env.prod instead (./openexam install). Safe to edit; re-running
# ./openexam install local keeps it and only fills in missing values.

DATABASE_URL=postgresql://openexam:openexam@localhost:5432/openexam
REDIS_URL=redis://localhost:6379

NEXT_PUBLIC_BASE_URL=http://localhost:3000
BETTER_AUTH_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000
# The dev server doesn't proxy /ws/ like nginx does in production, so the
# browser talks to ws-backend directly (allowed by the dev CSP).
NEXT_PUBLIC_WS_URL=ws://localhost:8080

BETTER_AUTH_SECRET=$(oe_secret_b64 32)
MATCHING_ID_SECRET=$(oe_secret_b64 32)
AT_REST_ENC_KEY=$(oe_secret_b64 32)
# Code teachers enter when self-registering at /register-teacher.
TEACHER_ACCESS_CODE=$(oe_secret_alnum 16)

# Cap captcha (docker-compose.yml's cap service). With DISABLE_CAPTCHA=true
# the bot check is skipped entirely (dev/test only, refused in production).
CAP_ADMIN_KEY=$(oe_secret_alnum 32)
CAP_SECRET_KEY=sk-$(oe_secret_alnum 40)
NEXT_PUBLIC_CAP_WIDGET_ENDPOINT=/cap-api/$(oe_secret_hex 5)/
CAP_ORIGIN=http://localhost:8090
CAP_SITEVERIFY_URL=http://localhost:8090/siteverify
DISABLE_CAPTCHA=$( [ "$captcha" = real ] || echo true )

# Optional: leave empty and verification links are logged to the console.
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="OpenExam <no-reply@localhost>"
EOF
  )
}

# Fills in what an older or hand-made .env lacks (a copy of .env.example has
# no DATABASE_URL, for one) without touching anything that's already set.
oe_repair_dev_env() {
  local added="" key value
  set_if_missing() {
    key="$1"; value="$2"
    if env_is_placeholder "$(env_get "$key" "$DEV_ENV")"; then
      env_set "$key" "$value" "$DEV_ENV"
      added="$added $key"
    fi
  }
  set_if_missing DATABASE_URL postgresql://openexam:openexam@localhost:5432/openexam
  set_if_missing REDIS_URL redis://localhost:6379
  set_if_missing NEXT_PUBLIC_BASE_URL http://localhost:3000
  set_if_missing BETTER_AUTH_URL http://localhost:3000
  set_if_missing NEXT_PUBLIC_WS_URL ws://localhost:8080
  set_if_missing BETTER_AUTH_SECRET "$(oe_secret_b64 32)"
  set_if_missing MATCHING_ID_SECRET "$(oe_secret_b64 32)"
  set_if_missing AT_REST_ENC_KEY "$(oe_secret_b64 32)"
  set_if_missing TEACHER_ACCESS_CODE "$(oe_secret_alnum 16)"
  set_if_missing CAP_ADMIN_KEY "$(oe_secret_alnum 32)"
  set_if_missing CAP_SECRET_KEY "sk-$(oe_secret_alnum 40)"
  case "$(env_get NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "$DEV_ENV")" in
    "" | /cap-api/change-me/)
      env_set NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "/cap-api/$(oe_secret_hex 5)/" "$DEV_ENV"
      added="$added NEXT_PUBLIC_CAP_WIDGET_ENDPOINT" ;;
  esac
  # A .env copied from .env.example carries the production example origin,
  # which would break CSRF checks and auth links on localhost.
  for key in NEXT_PUBLIC_BASE_URL BETTER_AUTH_URL ALLOWED_ORIGINS; do
    case "$(env_get "$key" "$DEV_ENV")" in
      *example.com*)
        env_set "$key" http://localhost:3000 "$DEV_ENV"
        added="$added $key" ;;
    esac
  done
  # docker-compose.yml falls back to the password DATABASE_URL uses only
  # when POSTGRES_PASSWORD is empty; .env.example's placeholder would
  # initialize the database with a different one.
  if [ -n "$(env_get POSTGRES_PASSWORD "$DEV_ENV")" ] \
    && env_is_placeholder "$(env_get POSTGRES_PASSWORD "$DEV_ENV")"; then
    env_set POSTGRES_PASSWORD "" "$DEV_ENV"
    added="$added POSTGRES_PASSWORD(cleared)"
  fi
  if [ -n "$added" ]; then
    ui_ok "Kept .env, filled in:$added"
  else
    ui_ok "Kept .env (nothing missing)"
  fi
}

# ── install local ───────────────────────────────────────────────────────────

cmd_install_local() {
  local demo=ask captcha=ask reset_env=0 start=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --demo) demo=yes ;;
      --no-demo) demo=no ;;
      --captcha) captcha=real ;;
      --reset-env) reset_env=1 ;;
      --no-start) start=0 ;;
      -h | --help) local_usage; return 0 ;;
      *) ui_die "Unknown option: $1 (see ./openexam install local --help)" ;;
    esac
    shift
  done

  local os
  os=$(oe_os)
  ui_banner "local development setup"
  case "$os" in
    linux | macos) ;;
    *) ui_die "Unsupported OS ($(uname -s)). Use Linux, macOS, or WSL2 on Windows." ;;
  esac

  ui_header "Checking your machine"
  ui_ok "$(oe_distro_pretty), $(oe_cpus) CPUs, $(( $(oe_mem_mb) / 1024 )) GB RAM"
  oe_ensure_docker
  oe_ensure_node
  oe_ensure_pnpm
  oe_check_dev_ports

  ui_header "Configuration"
  local env_action=new
  if [ -f "$DEV_ENV" ]; then
    if [ "$reset_env" -eq 1 ]; then
      env_action=reset
    else
      ui_select env_action "A .env already exists. What should happen to it?" 0 \
        "keep|Keep it|only fill in values that are missing" \
        "reset|Start fresh|back it up first, then write a new one"
    fi
  fi

  if [ "$captcha" = ask ]; then
    if [ "$env_action" = keep ]; then
      if [ "$(env_get DISABLE_CAPTCHA "$DEV_ENV")" = true ]; then captcha=off; else captcha=real; fi
    else
      ui_select captcha "Captcha (Cap) in development?" 0 \
        "off|Off|DISABLE_CAPTCHA=true — simplest, recommended" \
        "real|Real Cap captcha|registers a site key in the local cap container"
    fi
  fi

  case "$env_action" in
    keep) oe_repair_dev_env ;;
    reset)
      local backup
      backup="$DEV_ENV.bak-$(date +%Y%m%d-%H%M%S)"
      cp -p "$DEV_ENV" "$backup"
      oe_write_dev_env "$captcha"
      ui_ok "Wrote a fresh .env (old one saved as $backup)"
      ;;
    new)
      oe_write_dev_env "$captcha"
      ui_ok "Wrote .env with fresh development secrets"
      ;;
  esac
  if [ "$captcha" = real ]; then env_set DISABLE_CAPTCHA "" "$DEV_ENV"; fi

  if [ "$demo" = ask ]; then
    if ui_confirm "Seed demo data (a teacher, a student, a class and exams in every state)?" n; then
      demo=yes
    else
      demo=no
    fi
  fi

  ui_header "Setting up"
  ui_run "Installing dependencies (pnpm install)" pnpm install --frozen-lockfile \
    || ui_die "pnpm install failed."
  ui_run "Starting Postgres, Valkey, ws-backend and Cap (first run builds ws-backend)" \
    oe_dev up -d --build --wait || ui_die "The dev services didn't start. Check: docker compose ps"
  ui_run "Applying database migrations" pnpm exec prisma migrate deploy \
    || ui_die "Migrations failed."
  ui_run "Generating the Prisma client" pnpm exec prisma generate \
    || ui_die "prisma generate failed."

  if [ "$captcha" = real ]; then
    ui_run "Registering the Cap site key" \
      env OE_COMPOSE_FILE=docker-compose.yml OE_ENV_FILE="$DEV_ENV" ./scripts/create-cap-site-key.sh \
      || ui_warn "Couldn't register the site key — captcha checks will fail until it is."
  fi

  local demo_lines=""
  if [ "$demo" = yes ]; then
    if ui_run "Seeding demo data" pnpm exec tsx --env-file="$DEV_ENV" scripts/seed-demo.ts --apply; then
      demo_lines=$(grep -E '^(Lehrperson|Schüler) +:' "$OE_LOG" | tail -n 2 || true)
    fi
  fi

  ui_header "Ready"
  ui_kv "App" "http://localhost:3000"
  ui_kv "Teacher access code" "$(env_get TEACHER_ACCESS_CODE "$DEV_ENV")"
  ui_kv "Captcha" "$( [ "$captcha" = real ] && echo "Cap (real)" || echo "off (DISABLE_CAPTCHA=true)")"
  ui_kv "Email" "not sent — verification links are logged by the dev server"
  if [ -n "$demo_lines" ]; then
    printf '%s\n' "$demo_lines" | while IFS= read -r line; do ui_kv "Demo login" "$line"; done
  fi
  echo
  ui_dim "Next time, just run: ./openexam dev"

  if [ "$start" -eq 1 ] && ui_interactive && ui_confirm "Start the dev server now?" y; then
    cmd_dev --no-stop-hint
  fi
}

# ── dev ─────────────────────────────────────────────────────────────────────

cmd_dev() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --stop)
        ui_run "Stopping dev services (data is kept)" oe_dev stop
        return
        ;;
      -h | --help) dev_usage; return 0 ;;
      --no-stop-hint) ;; # internal: called from install local
      *) ui_die "Unknown option: $1 (see ./openexam dev --help)" ;;
    esac
  done

  [ -f "$DEV_ENV" ] || ui_die "No .env yet — run ./openexam install local first."

  if ! oe_docker_running; then
    if [ "$(oe_os)" = macos ]; then
      oe_mac_start_docker || ui_die "Start Docker, then re-run."
    else
      ui_die "Docker isn't running. Start it (sudo systemctl start docker) and re-run."
    fi
    oe_wait_for_docker 120 || ui_die "Docker didn't come up within 2 minutes."
  fi

  oe_node_ok || oe_prefer_node || ui_die "Node 26 or newer is required — run ./openexam install local."

  if [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
    ui_run "Installing dependencies (lockfile changed)" pnpm install --frozen-lockfile \
      || ui_die "pnpm install failed."
  fi

  ui_run "Starting dev services" oe_dev up -d --wait \
    || ui_die "The dev services didn't start. Check: docker compose ps"

  # `migrate status` exits non-zero when migrations are pending.
  if ! pnpm exec prisma migrate status >> "$OE_LOG" 2>&1; then
    if ui_confirm "There are unapplied database migrations. Apply them now?" y; then
      ui_run "Applying database migrations" pnpm exec prisma migrate deploy \
        || ui_die "Migrations failed."
      ui_run "Generating the Prisma client" pnpm exec prisma generate || true
    fi
  fi

  ui_ok "Services up — starting Next.js on http://localhost:3000 (Ctrl-C to stop)"
  echo
  exec pnpm dev
}
