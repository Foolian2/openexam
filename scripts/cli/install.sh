# shellcheck shell=bash
# ./openexam install — guided production install on a Linux server.
#
# Runs the same steps, in the same order, as scripts/setup-prod.sh (which
# stays the non-interactive engine and keeps working on its own), with the
# questions setup-prod.sh leaves to hand-editing .env.prod asked up front:
# the school's details for the legal pages, SMTP, Microsoft login,
# monitoring, offsite backups, the first admin.

# shellcheck source=scripts/cli/local.sh
. scripts/cli/local.sh
# shellcheck source=scripts/cli/teacher.sh
. scripts/cli/teacher.sh
# shellcheck source=scripts/cli/backup.sh
. scripts/cli/backup.sh

install_usage() {
  cat <<EOF
Usage: ./openexam install [options]

Guided production install: checks the server, asks for the domain and
optional features, then builds and starts everything with TLS, backups,
cron and firewall. Safe to re-run: an existing .env.prod is never replaced.

  --domain DOMAIN        Public domain (A record pointing at this server)
  --email EMAIL          Admin email (Let's Encrypt, test mail, first login)
  --monitoring           Also install the monitoring stack
  --no-monitoring        Don't ask about monitoring
  --no-offsite           Don't ask about offsite backups
  --no-teacher           Don't create the first admin account
  --restore              Rebuild a lost server from an offsite backup

Non-interactive (-y): --domain and --email are required, and so are
LEGAL_CONTROLLER_NAME, LEGAL_CONTROLLER_ADDRESS, LEGAL_CONTACT_EMAIL and
LEGAL_HOSTING_PROVIDER exported in the environment (the school's details on
/datenschutz and /impressum — see .env.example); SMTP_* and
MICROSOFT_* exported in the environment are written to .env.prod; the first
admin is created when TEACHER_PASSWORD (+ TEACHER_NAME) is exported; offsite
backups are set up when OFF_TYPE and its OFF_* values are exported (see
./openexam backup-offsite --help).

For local development use: ./openexam install local
EOF
}

# ── DNS ─────────────────────────────────────────────────────────────────────

# A records for $1 from a public resolver — same approach as
# scripts/check-dns.sh (which needs .env.prod; this runs before it exists).
oe_dns_a_records() {
  local domain="$1" ips=""
  if oe_has dig; then
    ips=$(dig +short "@8.8.8.8" "$domain" A 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' || true)
  fi
  if [ -z "$ips" ]; then
    ips=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)
  fi
  printf '%s' "$ips"
}

# Loops until DNS points here or the operator chooses to continue without
# it. Sets DNS_READY=1/0.
oe_dns_wizard() {
  local domain="$1" ip="$2" records choice
  DNS_READY=0
  # No public IP: the preflight already said the check is skipped.
  [ -n "$ip" ] || return 0
  while :; do
    records=$(oe_dns_a_records "$domain")
    if printf '%s\n' "$records" | grep -qx "$ip"; then
      ui_ok "DNS: $domain → $ip (this server)"
      DNS_READY=1
      return 0
    fi
    if [ -n "$records" ]; then
      ui_warn "DNS: $domain → $(printf '%s' "$records" | tr '\n' ' ')— not this server ($ip)."
    else
      ui_warn "DNS: $domain doesn't resolve yet."
    fi
    ui_dim "Create an A record: $domain → $ip (with Cloudflare: proxy off / grey cloud)."
    # Unattended runs check once and carry on with the temporary cert.
    ui_interactive || return 0
    ui_select choice "What now?" 0 \
      "recheck|Check again|after creating or fixing the record" \
      "continue|Continue without it|temporary self-signed cert; re-run later for the real one"
    [ "$choice" = continue ] && return 0
  done
}

# ── questions ───────────────────────────────────────────────────────────────

oe_ask_smtp() {
  SMTP_ENABLED=0
  if [ -n "${SMTP_HOST:-}" ]; then
    SMTP_ENABLED=1
  elif ui_confirm "Set up email (SMTP) for verification mails and password resets?" y; then
    SMTP_ENABLED=1
  fi
  if [ "$SMTP_ENABLED" -eq 0 ]; then
    ui_warn "No email: new accounts can't verify themselves and nobody can reset a forgotten password. Add SMTP_* to .env.prod later and run ./scripts/deploy.sh."
    return 0
  fi
  ui_ask SMTP_HOST "SMTP host" "${SMTP_HOST:-}"
  ui_ask SMTP_PORT "SMTP port (587 STARTTLS, 465 TLS)" "${SMTP_PORT:-587}" oe_valid_port
  if [ "$SMTP_PORT" = 465 ]; then SMTP_SECURE=true; else SMTP_SECURE="${SMTP_SECURE:-false}"; fi
  ui_ask_optional SMTP_USER "SMTP user" "${SMTP_USER:-}"
  if [ -n "$SMTP_USER" ] && [ -z "${SMTP_PASSWORD:-}" ]; then
    ui_secret SMTP_PASSWORD "SMTP password" 0 1 "SMTP_PASSWORD"
  fi
  SMTP_PASSWORD="${SMTP_PASSWORD:-}"
  ui_ask SMTP_FROM "Sender" "${SMTP_FROM:-OpenExam <no-reply@$DOMAIN>}"
}

oe_ask_microsoft() {
  MS_ENABLED=0
  if [ -n "${MICROSOFT_CLIENT_ID:-}" ]; then
    MS_ENABLED=1
  elif ui_confirm "Enable Microsoft 365 (Entra ID) login?" n; then
    MS_ENABLED=1
  fi
  [ "$MS_ENABLED" -eq 1 ] || return 0
  ui_dim "Redirect URI to register in Entra: https://$DOMAIN/api/auth/callback/microsoft-entra-id"
  ui_ask MICROSOFT_CLIENT_ID "Application (client) ID" "${MICROSOFT_CLIENT_ID:-}"
  if [ -z "${MICROSOFT_CLIENT_SECRET:-}" ]; then
    ui_secret MICROSOFT_CLIENT_SECRET "Client secret" 0 1 "MICROSOFT_CLIENT_SECRET"
  fi
  ui_ask MICROSOFT_TENANT_ID "Tenant ID (GUID)" "${MICROSOFT_TENANT_ID:-}" oe_valid_tenant "MICROSOFT_TENANT_ID"
  ui_dim "Microsoft logins are only accepted for these email domains (comma-separated)."
  local domain_issue
  while :; do
    ui_ask_optional SCHOOL_STUDENT_DOMAINS "Student email domains" "${SCHOOL_STUDENT_DOMAINS:-}"
    ui_ask_optional SCHOOL_TEACHER_DOMAINS "Teacher email domains" "${SCHOOL_TEACHER_DOMAINS:-}"
    if [ -z "$SCHOOL_STUDENT_DOMAINS$SCHOOL_TEACHER_DOMAINS" ]; then
      ui_interactive || ui_die "Microsoft login needs SCHOOL_STUDENT_DOMAINS and/or SCHOOL_TEACHER_DOMAINS"
      ui_warn "Set at least one domain, or every Microsoft login is rejected."
      continue
    fi
    # The web tier refuses to boot on these (lib/env.ts), so catch them here.
    domain_issue=$(oe_school_domains_issue "$SCHOOL_STUDENT_DOMAINS" "$SCHOOL_TEACHER_DOMAINS") && break
    ui_interactive || ui_die "School email domains: $domain_issue"
    ui_warn "$domain_issue — enter both lists again."
    # Cleared so the re-ask doesn't offer the rejected value as its default,
    # which an empty answer could not otherwise remove.
    SCHOOL_STUDENT_DOMAINS="" SCHOOL_TEACHER_DOMAINS=""
  done
}

oe_ask_monitoring() {
  local mem
  mem=$(oe_mem_mb)
  case "$MONITORING" in
    yes | no) ;;
    *)
      ui_dim "Monitoring adds Prometheus, Grafana, alert emails, error tracking and"
      ui_dim "point-in-time recovery. It needs about 2 GB of extra RAM (this server: $((mem / 1024)) GB)."
      if ui_confirm "Install the monitoring stack too?" "$( [ "$mem" -ge 7500 ] && echo y || echo n )"; then
        MONITORING=yes
      else
        MONITORING=no
      fi
      ;;
  esac
  if [ "$MONITORING" = yes ]; then
    [ "$SMTP_ENABLED" -eq 1 ] || ui_warn "Alerts are sent by email — without SMTP they go nowhere."
    ui_ask ALERT_EMAIL_TO "Send alerts to" "${ALERT_EMAIL_TO:-$ACME_EMAIL}" oe_valid_email
  fi
}

# ── steps ───────────────────────────────────────────────────────────────────

oe_write_answers() {
  env_set ACME_EMAIL "$ACME_EMAIL" "$PROD_ENV"
  oe_write_legal
  if [ "$SMTP_ENABLED" -eq 1 ]; then
    env_set SMTP_HOST "$SMTP_HOST" "$PROD_ENV"
    env_set SMTP_PORT "$SMTP_PORT" "$PROD_ENV"
    env_set SMTP_SECURE "$SMTP_SECURE" "$PROD_ENV"
    env_set SMTP_USER "$SMTP_USER" "$PROD_ENV"
    env_set SMTP_PASSWORD "$SMTP_PASSWORD" "$PROD_ENV"
    env_set SMTP_FROM "$SMTP_FROM" "$PROD_ENV"
  fi
  if [ "$MS_ENABLED" -eq 1 ]; then
    env_set MICROSOFT_CLIENT_ID "$MICROSOFT_CLIENT_ID" "$PROD_ENV"
    env_set MICROSOFT_CLIENT_SECRET "$MICROSOFT_CLIENT_SECRET" "$PROD_ENV"
    env_set MICROSOFT_TENANT_ID "$MICROSOFT_TENANT_ID" "$PROD_ENV"
    env_set SCHOOL_STUDENT_DOMAINS "$SCHOOL_STUDENT_DOMAINS" "$PROD_ENV"
    env_set SCHOOL_TEACHER_DOMAINS "$SCHOOL_TEACHER_DOMAINS" "$PROD_ENV"
  fi
  if [ "$MONITORING" = yes ]; then
    env_set ALERT_EMAIL_TO "$ALERT_EMAIL_TO" "$PROD_ENV"
  fi
}

# SMTP_* from .env.prod, exported so `docker compose run -e NAME` passes
# them by name — values never appear on a command line or in the log.
oe_smtp_test() {
  local to="$1" var
  for var in SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD SMTP_FROM; do
    printf -v "$var" '%s' "$(env_get "$var" "$PROD_ENV")"
    export "${var?}"
  done
  oe_prod_tsx -e SMTP_HOST -e SMTP_PORT -e SMTP_SECURE -e SMTP_USER -e SMTP_PASSWORD -e SMTP_FROM \
    -- scripts/smtp-test.ts "$to"
}

# Sends the test mail; on failure offers to re-enter the settings. Sets
# SMTP_CHANGED=1 when .env.prod was edited (the web tier then needs a
# redeploy to pick it up).
oe_smtp_test_loop() {
  local choice
  SMTP_CHANGED=0
  SMTP_OK=0
  while :; do
    if ui_run "Sending a test email to $ACME_EMAIL" oe_smtp_test "$ACME_EMAIL"; then
      SMTP_OK=1
      ui_dim "Check that inbox (and its spam folder)."
      return 0
    fi
    # Unattended: report it and carry on; the final screen says email is off.
    ui_interactive || return 0
    ui_select choice "The test email failed. What now?" 0 \
      "retry|Re-enter the SMTP settings|" \
      "skip|Continue without working email|fix .env.prod later and run ./scripts/deploy.sh"
    [ "$choice" = skip ] && return 0
    SMTP_HOST="" SMTP_PASSWORD="" SMTP_USER=""
    oe_ask_smtp
    oe_write_answers
    SMTP_CHANGED=1
  done
}

oe_final_screen() {
  local tls
  if oe_cert_self_signed "$CERT_LIVE/fullchain.pem"; then
    tls="temporary self-signed — run ./scripts/issue-cert.sh once DNS points here"
  else
    tls="Let's Encrypt, renews automatically"
  fi
  ui_header "OpenExam is running"
  ui_kv "URL" "https://$DOMAIN"
  ui_kv "TLS" "$tls"
  [ -n "${TEACHER_CREATED:-}" ] && ui_kv "Admin login" "$TEACHER_EMAIL"
  ui_kv "Teacher access code" "$(env_get TEACHER_ACCESS_CODE "$PROD_ENV")"
  if [ "${SMTP_OK:-0}" -eq 1 ]; then
    ui_kv "Email" "working (test mail sent)"
  elif [ -n "$(env_get SMTP_HOST "$PROD_ENV")" ]; then
    ui_kv "Email" "configured, not tested here — ./openexam doctor --smtp"
  else
    ui_kv "Email" "not configured"
  fi
  ui_kv "Backups" "daily at 03:00 in ./backups (kept 14 days)"
  if oe_offsite_configured; then
    ui_kv "Offsite" "daily at 03:15 to $(sed -n 's/^type = //p' "$RCLONE_CONF" | head -1)$(grep -q '^type = crypt' "$RCLONE_CONF" && echo ", encrypted")"
  else
    ui_kv "Offsite" "not configured"
  fi
  ui_kv "Monitoring" "$( [ "$MONITORING" = yes ] && echo "installed — see DEPLOYMENT.md for the SSH tunnel" || echo "not installed (./scripts/setup-monitoring.sh)")"
  echo
  if ! oe_offsite_configured; then
    printf '  %s%s Copy .env.prod somewhere safe, off this server.%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
    ui_dim "Without it a rebuilt server can't read the restored data. Or set up: ./openexam backup-offsite"
    echo
  fi
  if [ -z "${TEACHER_CREATED:-}" ] && [ -z "${OE_RESTORED:-}" ]; then
    ui_dim "Create an admin login: ./openexam create-teacher"
  fi
  ui_dim "Teachers self-register at https://$DOMAIN/register-teacher with the access code."
  ui_dim "Day to day: ./openexam update · ./openexam status · ./openexam doctor · ./openexam backup"
}

# Brings up the stack the way setup-prod.sh does. $1=restore to restore a
# dump (path in $2) before the web tier starts.
oe_bring_up() {
  local mode="${1:-fresh}" dump="${2:-}" before_key after_key

  ui_run "Creating a temporary TLS certificate" ./scripts/bootstrap-cert.sh || ui_die "bootstrap-cert.sh failed."

  if [ "$mode" = restore ]; then
    # cap is left to deploy.sh: its healthcheck probes the configured site
    # key, which a fresh Valkey doesn't know yet (create-cap-site-key.sh
    # registers it below), so waiting on it here would always fail.
    ui_run "Building and starting the database services" \
      oe_prod up -d --build --wait postgres redis || ui_die "Couldn't start the database services."
    ui_run "Restoring $(basename "$dump")" oe_pg_restore "$dump" || ui_die "Restore failed — see the log."
  fi

  ui_run "Building and starting OpenExam (first build: 5–15 minutes)" ./scripts/deploy.sh \
    || ui_die "Deploy failed — see the log above. Fix it, then run ./openexam install again."

  before_key=$(env_get NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "$PROD_ENV")
  ui_run "Registering the captcha site key" ./scripts/create-cap-site-key.sh \
    || ui_die "create-cap-site-key.sh failed."
  after_key=$(env_get NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "$PROD_ENV")
  if [ "$before_key" != "$after_key" ]; then
    ui_run "Rebuilding with the captcha site key" ./scripts/deploy.sh || ui_die "Deploy failed."
  fi

  if [ "${DNS_READY:-0}" -eq 1 ]; then
    ui_run "Getting a Let's Encrypt certificate" ./scripts/issue-cert.sh \
      || ui_warn "Certificate issuance failed — the temporary cert stays. Retry: ./scripts/issue-cert.sh"
  else
    ui_warn "Skipping Let's Encrypt (DNS not ready). Later: ./scripts/issue-cert.sh"
  fi

  ui_run "Installing cron jobs (renewal, backups)" ./scripts/install-cron.sh || ui_warn "install-cron.sh failed."
  if ! oe_has ufw; then
    case "$(oe_distro)" in
      ubuntu | debian)
        # Only asked on a terminal: an unattended run that finds no
        # firewall tool reports it rather than installing packages.
        if ui_interactive && ui_confirm "ufw (the firewall tool) isn't installed. Install it?" y; then
          ui_run "Installing ufw" oe_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ufw || true
        fi
        ;;
    esac
  fi
  if oe_has ufw; then
    ui_run "Configuring the firewall (SSH $(oe_ssh_port), 80, 443)" oe_as_root ./scripts/configure-firewall.sh \
      || ui_warn "Firewall setup failed — run: sudo ./scripts/configure-firewall.sh"
  else
    ui_warn "No ufw — firewall not configured. Install ufw, then: sudo ./scripts/configure-firewall.sh"
  fi
}

# ── restore-from-offsite (rebuild a lost server) ────────────────────────────

oe_install_restore() {
  ui_header "Rebuild from an offsite backup"
  local tmp_env resume=0
  if [ -f "$PROD_ENV" ] && oe_offsite_configured; then
    # A previous --restore got as far as fetching the configuration: carry
    # on with it instead of asking for the target again.
    resume=1
    ui_ok "Resuming with the .env.prod and offsite target from the previous attempt"
  else
    ui_dim "You need the offsite target's credentials and the encryption passphrase."
    oe_offsite_ask
    local encrypted=1
    ui_confirm "Were the backups encrypted (the default)?" y || encrypted=0
    if [ "$encrypted" -eq 1 ] && [ -z "${OFF_PASSPHRASE:-}" ]; then
      ui_secret OFF_PASSPHRASE "Encryption passphrase" 0 1 "OFF_PASSPHRASE"
    fi
    oe_offsite_write_conf "$( [ "$encrypted" -eq 1 ] && printf '%s' "$OFF_PASSPHRASE")"
  fi

  if [ "$resume" -eq 1 ]; then
    tmp_env=$(mktemp .env.prod.restore.XXXXXX)
    cp -p "$PROD_ENV" "$tmp_env"
  else
    tmp_env=$(mktemp .env.prod.restore.XXXXXX)
    if ! ui_run "Fetching .env.prod from the offsite copy" ./scripts/offsite.sh fetch-env "$tmp_env"; then
      rm -f "$tmp_env" "$RCLONE_CONF"
      ui_die "Couldn't fetch .env.prod — wrong credentials or passphrase?"
    fi
  fi
  DOMAIN=$(env_get DOMAIN "$tmp_env")
  ACME_EMAIL=$(env_get ACME_EMAIL "$tmp_env")
  ACME_EMAIL="${ACME_EMAIL:-admin@$DOMAIN}"
  ui_ok "Found the configuration for $DOMAIN"

  local -a remote opts
  remote=()
  while IFS= read -r line; do remote+=("$line"); done < <(./scripts/offsite.sh list 2>>"$OE_LOG" | head -n 10)
  [ "${#remote[@]}" -gt 0 ] || ui_die "No dumps found offsite."
  opts=()
  for line in "${remote[@]}"; do
    opts+=("${line%%;*}|${line%%;*}|$(( ${line#*;} / 1024 / 1024 )) MB")
  done
  local pick
  ui_select pick "Restore which dump? (newest first)" 0 "${opts[@]}"

  oe_dns_wizard "$DOMAIN" "$PUBLIC_IP"

  echo
  ui_kv "Domain" "$DOMAIN"
  ui_kv "Dump" "$pick"
  ui_kv "Secrets" "restored from the offsite .env.prod (not regenerated)"
  ui_confirm "Rebuild now?" y || { rm -f "$tmp_env"; ui_die "Aborted — nothing changed."; }

  mv "$tmp_env" "$PROD_ENV"
  chmod 600 "$PROD_ENV"
  if [ "$(env_get WALG_STORAGE_BACKEND "$PROD_ENV")" = sftp ]; then
    # The wal-g SSH key, libsodium key and pinned host key are not part of
    # the offsite copy, and production-compose.sh refuses to run without
    # them. Restore the independent pg_dump first; re-enable PITR afterwards.
    env_set WALG_STORAGE_BACKEND disabled "$PROD_ENV"
    ui_warn "WAL-G (point-in-time recovery) is switched off for this rebuild — its secrets aren't in the offsite backup."
    ui_dim "Set it up again afterwards (DEPLOYMENT.md, PITR section)."
  fi
  # A .env.prod backed up before the legal pages existed lacks their
  # details, and deploy.sh would stop on them.
  oe_ensure_legal
  mkdir -p backups && chmod 700 backups
  ui_run "Downloading $pick" ./scripts/offsite.sh fetch "$pick" backups || ui_die "Download failed."

  ui_header "Rebuilding"
  oe_bring_up restore "backups/$pick"
  ui_run "Installing the daily offsite cron job" ./scripts/install-cron.sh || true
  MONITORING=no
  OE_RESTORED=1
  oe_final_screen
  ui_dim "Accounts and passwords are the ones from the backup."
}

# ── main ────────────────────────────────────────────────────────────────────

cmd_install() {
  DOMAIN="${OE_DOMAIN:-}" ACME_EMAIL="${OE_EMAIL:-}" MONITORING=ask
  local offsite=ask teacher=ask restore=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="${2:?--domain needs a value}"; shift ;;
      --email) ACME_EMAIL="${2:?--email needs a value}"; shift ;;
      --monitoring) MONITORING=yes ;;
      --no-monitoring) MONITORING=no ;;
      --no-offsite) offsite=no ;;
      --no-teacher) teacher=no ;;
      --restore) restore=1 ;;
      -h | --help) install_usage; return 0 ;;
      *) ui_die "Unknown option: $1 (see ./openexam install --help)" ;;
    esac
    shift
  done

  ui_banner "production install"
  if [ "$(oe_os)" != linux ]; then
    ui_err "The production install is for a Linux server (Ubuntu 24.04 recommended)."
    ui_dim "For development on this machine: ./openexam install local"
    exit 1
  fi

  ui_header "Checking this server"
  case "$(oe_distro)" in
    ubuntu | debian) ui_ok "$(oe_distro_pretty)" ;;
    *) ui_warn "$(oe_distro_pretty) — tested on Ubuntu 24.04; continuing anyway." ;;
  esac
  oe_has sudo || oe_is_root || ui_die "Needs root or sudo (firewall, Docker)."
  oe_sudo_prime

  local mem disk
  mem=$(oe_mem_mb); disk=$(oe_disk_free_gb .)
  if [ "$mem" -lt 3500 ]; then
    ui_warn "$((mem / 1024)) GB RAM — 4 GB is the minimum (Hetzner CX22); builds may run out of memory."
  else
    ui_ok "$(oe_cpus) CPUs, $((mem / 1024)) GB RAM"
  fi
  if [ "${disk:-0}" -lt 20 ]; then
    ui_warn "${disk} GB free disk — 20 GB or more recommended (images, dumps, WAL)."
  else
    ui_ok "${disk} GB free disk"
  fi

  oe_ensure_docker

  local port owner
  for port in 80 443; do
    owner=$(oe_port_owner "$port")
    case "$owner" in
      "") ;;
      docker-pr* | docker*)
        # docker-proxy also fronts unrelated containers: only OpenExam's own
        # nginx (an earlier install being re-run) may hold the port.
        if [ -z "$(oe_prod ps -q nginx 2>/dev/null)" ] || ! oe_prod ps nginx 2>/dev/null | grep -q ":$port->"; then
          ui_die "Port $port is published by another Docker container — stop it first (OpenExam's nginx needs 80 and 443)."
        fi
        ;;
      *) ui_die "Port $port is taken by $owner — stop it first (OpenExam's nginx needs 80 and 443)." ;;
    esac
  done
  ui_ok "Ports 80 and 443 available"

  if oe_git_dirty; then
    ui_err "The git checkout has uncommitted changes — deploy.sh tags images by commit and refuses."
    git status --short | head -n 10 | sed 's/^/      /'
    exit 1
  fi
  ui_ok "Code at $(git rev-parse --short HEAD) ($(git log -1 --format=%cs))"

  PUBLIC_IP=$(oe_public_ip)
  if [ -n "$PUBLIC_IP" ]; then ui_ok "Public IP $PUBLIC_IP"; else ui_warn "Couldn't determine the public IP — the DNS check will be skipped"; fi

  if [ "$restore" -eq 1 ]; then
    if [ -s .deploy-history ]; then
      ui_die "This server already runs OpenExam — to bring back data, use ./openexam restore (it takes a safety dump first)."
    fi
    oe_install_restore
    return
  fi

  # ── existing install ──
  if [ -f "$PROD_ENV" ]; then
    DOMAIN=$(oe_domain)
    ACME_EMAIL=$(env_get ACME_EMAIL "$PROD_ENV")
    local choice default=0
    ui_header "Existing install found ($DOMAIN)"
    ui_dim ".env.prod is never regenerated: its secrets initialized the database."
    # Nothing deployed successfully yet (a first install that failed part
    # way): carrying on with the setup is the likely intent, not an update.
    if [ ! -s .deploy-history ]; then
      default=1
      ui_dim "No successful deploy yet — the default is to continue the setup."
    fi
    ui_select choice "What do you want to do?" "$default" \
      "update|Update|pull the latest code and deploy" \
      "repair|Repair / continue setup|re-run every setup step (all idempotent)" \
      "abort|Nothing|exit"
    case "$choice" in
      update)
        # shellcheck source=scripts/cli/ops.sh
        . scripts/cli/ops.sh
        cmd_update
        return
        ;;
      repair)
        DNS_READY=0
        [ -n "$PUBLIC_IP" ] && oe_dns_wizard "$DOMAIN" "$PUBLIC_IP"
        oe_ensure_legal
        ui_header "Repairing"
        oe_bring_up fresh
        SMTP_OK=0
        MONITORING=$( [ -f monitoring/alertmanager/alertmanager.yml ] && echo yes || echo no)
        oe_final_screen
        return
        ;;
      *) return 0 ;;
    esac
  fi

  # ── new install or rebuild ──
  if [ "$restore" -eq 0 ] && ui_interactive; then
    local mode
    ui_select mode "Fresh install, or rebuild a lost server?" 0 \
      "fresh|Fresh install|new database, new secrets" \
      "restore|Restore from an offsite backup|brings back .env.prod and the latest dump"
    [ "$mode" = restore ] && restore=1
  fi
  if [ "$restore" -eq 1 ]; then
    oe_install_restore
    return
  fi

  ui_header "Your instance"
  ui_ask DOMAIN "Domain" "$DOMAIN" oe_valid_domain "--domain"
  ui_ask ACME_EMAIL "Admin email (Let's Encrypt notices, test mail, first login)" "$ACME_EMAIL" oe_valid_email "--email"
  oe_dns_wizard "$DOMAIN" "$PUBLIC_IP"

  ui_header "Datenschutzerklärung & Impressum"
  oe_ask_legal "$ACME_EMAIL"

  ui_header "Optional features"
  oe_ask_smtp
  oe_ask_microsoft
  oe_ask_monitoring

  if [ "$offsite" = ask ]; then
    if [ -n "${OFF_TYPE:-}" ] \
      || ui_confirm "Set up encrypted offsite backups now? (recommended)" "$(ui_interactive && echo y || echo n)"; then
      offsite=yes
      oe_offsite_ask
    else
      offsite=no
    fi
  fi

  if [ "$teacher" = ask ]; then
    if [ -n "${TEACHER_PASSWORD:-}" ] || ui_confirm "Create the first admin account now?" "$(ui_interactive && echo y || echo n)"; then
      teacher=yes
      TEACHER_ROLE="${TEACHER_ROLE:-}"
      oe_ask_teacher "$ACME_EMAIL" ADMIN 0
    else
      teacher=no
    fi
  fi

  ui_header "Summary"
  ui_kv "Domain" "https://$DOMAIN"
  ui_kv "TLS" "$( [ "$DNS_READY" -eq 1 ] && echo "Let's Encrypt" || echo "temporary self-signed (DNS not ready)")"
  ui_kv "Admin email" "$ACME_EMAIL"
  ui_kv "School" "$LEGAL_CONTROLLER_NAME"
  ui_kv "Email (SMTP)" "$( [ "$SMTP_ENABLED" -eq 1 ] && echo "$SMTP_HOST:$SMTP_PORT" || echo "off")"
  ui_kv "Microsoft login" "$( [ "$MS_ENABLED" -eq 1 ] && echo "on (tenant $MICROSOFT_TENANT_ID)" || echo "off")"
  ui_kv "Monitoring" "$MONITORING"
  ui_kv "Offsite backups" "$( [ "$offsite" = yes ] && echo "$OFF_TYPE, encrypted" || echo "off")"
  ui_kv "First admin" "$( [ "$teacher" = yes ] && echo "$TEACHER_EMAIL ($TEACHER_ROLE)" || echo "none")"
  ui_kv "Firewall" "ufw: SSH $(oe_ssh_port), 80, 443"
  echo
  ui_confirm "Install now?" y || ui_die "Aborted — nothing changed."

  ui_header "Installing"
  ui_run "Generating .env.prod with fresh secrets" ./scripts/gen-env-prod.sh "$DOMAIN" \
    || ui_die "gen-env-prod.sh failed."
  oe_write_answers
  ui_ok "Wrote your answers to .env.prod"
  oe_secret_file_note .env.prod

  oe_bring_up fresh

  SMTP_OK=0
  if [ "$SMTP_ENABLED" -eq 1 ]; then
    oe_smtp_test_loop
    if [ "$SMTP_CHANGED" -eq 1 ]; then
      ui_run "Applying the new SMTP settings" ./scripts/deploy.sh || ui_warn "Redeploy failed."
    fi
  fi

  TEACHER_CREATED=""
  if [ "$teacher" = yes ]; then
    if ui_run "Creating the admin account $TEACHER_EMAIL" \
      oe_create_teacher prod "$TEACHER_EMAIL" "$TEACHER_NAME" "$TEACHER_ROLE"; then
      TEACHER_CREATED=1
    else
      ui_warn "Couldn't create it — retry with ./openexam create-teacher"
    fi
  fi

  if [ "$offsite" = yes ]; then
    local passphrase
    passphrase="${OFF_PASSPHRASE:-$(oe_secret_alnum 32)}"
    oe_offsite_write_conf "$passphrase"
    if oe_offsite_first_push; then
      [ -z "${OFF_PASSPHRASE:-}" ] && oe_offsite_show_passphrase "$passphrase"
    else
      ui_warn "Offsite push failed — fix the target and run ./openexam backup-offsite"
      rm -f "$RCLONE_CONF"
    fi
  fi

  if [ "$MONITORING" = yes ]; then
    ui_run "Installing the monitoring stack" ./scripts/setup-monitoring.sh \
      || ui_warn "setup-monitoring.sh failed — see the log, then re-run it."
  fi

  oe_final_screen
}
