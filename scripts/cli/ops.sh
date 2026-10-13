# shellcheck shell=bash
# ./openexam update | status | doctor | uninstall

# ── update ──────────────────────────────────────────────────────────────────

update_usage() {
  cat <<EOF
Usage: ./openexam update

Fetches the latest code for the current branch, shows what's new (and
whether it includes database migrations), pulls, and runs scripts/deploy.sh.
If the deploy fails, offers to roll back to the images that were running.
EOF
}

cmd_update() {
  case "${1:-}" in -h | --help) update_usage; return 0 ;; esac
  oe_require_prod_env
  ui_banner "update"

  if oe_git_dirty; then
    ui_err "The checkout has uncommitted changes — deploy.sh would refuse:"
    git status --short | head -n 10 | sed 's/^/      /'
    exit 1
  fi

  local branch running upstream count migrations
  branch=$(git rev-parse --abbrev-ref HEAD)
  running=$(tail -n 1 .deploy-history 2>/dev/null | cut -d' ' -f1)
  [ -n "$running" ] || running=$(git rev-parse --short HEAD)

  ui_run "Fetching $branch" git fetch origin "$branch" || ui_die "git fetch failed."
  upstream="origin/$branch"
  count=$(git rev-list --count "HEAD..$upstream")

  if [ "$count" -eq 0 ]; then
    ui_ok "Already up to date ($(git rev-parse --short HEAD))"
    ui_confirm "Redeploy anyway?" n || return 0
  else
    ui_info "$count new commit(s) on $branch:"
    { git log --format='%h %s' "HEAD..$upstream" || true; } | head -n 15 | sed 's/^/      /'
    [ "$count" -gt 15 ] && ui_dim "… and $((count - 15)) more"
    migrations=$(git diff --name-only "HEAD..$upstream" -- prisma/migrations | grep -c 'migration.sql$' || true)
    if [ "$migrations" -gt 0 ]; then
      ui_warn "Includes $migrations database migration(s). Migrations only go forward — a rollback won't undo them."
      ui_dim "Tip: ./openexam backup first."
    fi
    ui_confirm "Update and deploy now?" y || return 0
    ui_run "Pulling" git pull --ff-only origin "$branch" \
      || ui_die "git pull --ff-only failed (local commits diverge from $upstream?)."
  fi

  # Installs from before the legal pages need their details now, or
  # deploy.sh stops on them.
  oe_ensure_legal

  if ui_run "Deploying $(git rev-parse --short HEAD) (builds images, migrates, rolls containers)" ./scripts/deploy.sh; then
    ui_ok "Updated: $running → $(git rev-parse --short HEAD)"
    ui_dim "Rollback if needed: ./scripts/rollback.sh $running"
    return 0
  fi

  ui_err "The deploy failed."
  if docker image inspect "openexam-web:$running" >/dev/null 2>&1; then
    local choice
    ui_select choice "Roll back to the images that were running ($running)?" 0 \
      "rollback|Roll back now|scripts/rollback.sh $running — takes seconds" \
      "leave|Leave it|investigate first; the log has the details"
    if [ "$choice" = rollback ]; then
      ui_run "Rolling back to $running" ./scripts/rollback.sh "$running" \
        || ui_err "Rollback refused or failed — see the log (a newer migration may need --force)."
      ui_dim "The git checkout is still at $(git rev-parse --short HEAD); the next update rolls forward."
    fi
  fi
  exit 1
}

# ── status ──────────────────────────────────────────────────────────────────

oe_file_age_hours() {
  local mtime now
  if mtime=$(stat -c %Y "$1" 2>/dev/null); then :; else mtime=$(stat -f %m "$1"); fi
  now=$(date +%s)
  echo $(( (now - mtime) / 3600 ))
}

cmd_status() {
  case "${1:-}" in -h | --help) echo "Usage: ./openexam status"; return 0 ;; esac
  oe_require_prod_env
  local domain last_deploy newest days
  domain=$(oe_domain)
  ui_banner "status — $domain"

  last_deploy=$(tail -n 1 .deploy-history 2>/dev/null || true)
  ui_kv "Deployed" "${last_deploy:-unknown (no .deploy-history)}"
  ui_kv "Checkout" "$(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"

  ui_header "Containers"
  if oe_docker_running; then
    oe_prod ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null | sed 's/^/    /'
  else
    ui_err "Docker isn't running."
  fi

  ui_header "Health"
  if curl -fsk --noproxy "*" --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" >/dev/null 2>&1; then
    ui_ok "https://$domain/api/health answers"
  else
    ui_err "https://$domain/api/health does not answer"
  fi
  days=$(oe_cert_days_left "$CERT_LIVE/fullchain.pem")
  if [ -z "$days" ]; then
    ui_err "No TLS certificate at $CERT_LIVE"
  elif oe_cert_self_signed "$CERT_LIVE/fullchain.pem"; then
    ui_warn "TLS: temporary self-signed cert ($days days left) — ./scripts/issue-cert.sh"
  else
    ui_ok "TLS: $(oe_cert_issuer "$CERT_LIVE/fullchain.pem" | sed 's/.*O *= *\([^,]*\).*/\1/'), $days days left"
  fi

  ui_header "Backups"
  newest=$(ls -1t backups/openexam-*.dump 2>/dev/null | head -n 1 || true)
  if [ -n "$newest" ]; then
    ui_ok "Newest dump: $(basename "$newest") ($(du -h "$newest" | cut -f1), $(oe_file_age_hours "$newest") h ago)"
  else
    ui_warn "No local dumps yet (./openexam backup)"
  fi
  if [ -s .rclone.conf ]; then
    ui_ok "Offsite target configured"
  else
    ui_warn "No offsite target (./openexam backup-offsite)"
  fi
  ui_kv "Cron jobs" "$(crontab -l 2>/dev/null | grep -cF "$OE_ROOT" || true) for this install"
  ui_kv "Disk" "$(oe_disk_used_pct .)% used, $(oe_disk_free_gb .) GB free"
}

# ── doctor ──────────────────────────────────────────────────────────────────

DOCTOR_FAILS=0
DOCTOR_WARNS=0
doc_ok() { ui_ok "$*"; }
doc_warn() { ui_warn "$*"; DOCTOR_WARNS=$((DOCTOR_WARNS + 1)); }
doc_fail() { ui_err "$*"; DOCTOR_FAILS=$((DOCTOR_FAILS + 1)); }

doctor_usage() {
  cat <<EOF
Usage: ./openexam doctor [--local] [--smtp [ADDRESS]]

Checks configuration and host health; exits 1 when something is broken.
Checks production (.env.prod) by default, the dev setup with --local (also
the default when there is only a .env).

  --local          Check the development environment instead
  --smtp [ADDR]    Also send a test email (default: ACME_EMAIL)
EOF
}

# Same production minimums as PROD_MIN_LENGTHS in lib/env.ts.
doctor_secret() {
  local name="$1" min="$2" value
  value=$(env_get "$name" "$PROD_ENV")
  if env_is_placeholder "$value"; then
    doc_fail "$name is missing or a placeholder"
  elif [ "${#value}" -lt "$min" ]; then
    doc_fail "$name is shorter than $min characters"
  else
    return 0
  fi
  return 1
}

doctor_prod() {
  local smtp_to="$1" domain value days used site_key ok=1 perms

  ui_header "Configuration (.env.prod)"
  perms=$(stat -c %a "$PROD_ENV" 2>/dev/null || stat -f %Lp "$PROD_ENV")
  if [ "$perms" = 600 ]; then doc_ok ".env.prod is chmod 600"; else doc_warn ".env.prod is chmod $perms — should be 600 (chmod 600 .env.prod)"; fi

  doctor_secret BETTER_AUTH_SECRET 32 || ok=0
  doctor_secret MATCHING_ID_SECRET 32 || ok=0
  doctor_secret TEACHER_ACCESS_CODE 12 || ok=0
  doctor_secret AT_REST_ENC_KEY 32 || ok=0
  doctor_secret CAP_ADMIN_KEY 16 || ok=0
  doctor_secret CAP_SECRET_KEY 16 || ok=0
  doctor_secret POSTGRES_PASSWORD 1 || ok=0
  # docker-compose.prod.yml puts it into DATABASE_URL unescaped.
  case "$(env_get POSTGRES_PASSWORD "$PROD_ENV")" in
    */* | *@* | *:* | *\?* | *#* | *%*)
      doc_fail "POSTGRES_PASSWORD contains / @ : ? # or % — it breaks DATABASE_URL (migrate fails with P1013)"
      ok=0 ;;
  esac
  [ "$ok" -eq 1 ] && doc_ok "Secrets set and long enough"

  domain=$(oe_domain)
  if [ -z "$domain" ]; then
    doc_fail "DOMAIN is not set"
  else
    ok=1
    for var in NEXT_PUBLIC_BASE_URL BETTER_AUTH_URL ALLOWED_ORIGINS; do
      value=$(env_get "$var" "$PROD_ENV")
      if [ "$value" != "https://$domain" ]; then
        doc_fail "$var is '$value', expected https://$domain"
        ok=0
      fi
    done
    [ "$(env_get OPENEXAM_DOMAIN "$PROD_ENV")" = "$domain" ] || { doc_fail "OPENEXAM_DOMAIN doesn't match DOMAIN ($domain)"; ok=0; }
    [ "$ok" -eq 1 ] && doc_ok "Domain and origins consistent ($domain)"
  fi

  if [ -n "$(env_get MICROSOFT_CLIENT_ID "$PROD_ENV")$(env_get MICROSOFT_CLIENT_SECRET "$PROD_ENV")$(env_get MICROSOFT_TENANT_ID "$PROD_ENV")" ]; then
    if [ -z "$(env_get MICROSOFT_CLIENT_ID "$PROD_ENV")" ] || [ -z "$(env_get MICROSOFT_CLIENT_SECRET "$PROD_ENV")" ]; then
      doc_fail "Microsoft login is partly configured: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT_ID must all be set"
    elif [ -z "$(env_get SCHOOL_STUDENT_DOMAINS "$PROD_ENV")$(env_get SCHOOL_TEACHER_DOMAINS "$PROD_ENV")" ]; then
      doc_fail "Microsoft login is configured but SCHOOL_STUDENT_DOMAINS and SCHOOL_TEACHER_DOMAINS are both empty — the app refuses to boot"
    elif oe_valid_tenant "$(env_get MICROSOFT_TENANT_ID "$PROD_ENV")" >/dev/null; then
      doc_ok "Microsoft login configured (pinned tenant)"
    else
      doc_fail "Microsoft login is configured but MICROSOFT_TENANT_ID is not a tenant GUID — the app refuses to boot"
    fi
  fi

  local legal_missing
  legal_missing=$(oe_legal_missing "$PROD_ENV")
  if [ -z "$legal_missing" ]; then
    doc_ok "Legal pages configured ($(env_get LEGAL_CONTROLLER_NAME "$PROD_ENV"))"
  else
    doc_fail "Missing or invalid for /datenschutz and /impressum: $(printf '%s' "$legal_missing" | tr '\n' ' ')— the app refuses to boot (./openexam install → Repair asks for them)"
  fi
  value=$(env_get LEGAL_DPO_EMAIL "$PROD_ENV")
  if [ -n "$value" ] && ! oe_valid_legal_email "$value" >/dev/null; then
    doc_fail "LEGAL_DPO_EMAIL is not an email address — the app refuses to boot"
  fi

  if [ -n "$(env_get SMTP_HOST "$PROD_ENV")" ]; then
    doc_ok "SMTP configured ($(env_get SMTP_HOST "$PROD_ENV"))"
  else
    doc_warn "No SMTP — verification and reset emails can't be sent"
  fi

  ui_header "Host"
  if oe_docker_running; then
    doc_ok "Docker $(oe_docker_version), Compose $(oe_compose_version)"
  else
    doc_fail "Docker isn't running"
  fi
  used=$(oe_disk_used_pct .)
  if [ "${used:-0}" -ge 85 ]; then
    doc_fail "Disk ${used}% full — clean up (docker system prune, old dumps)"
  elif [ "${used:-0}" -ge 75 ]; then
    doc_warn "Disk ${used}% full"
  else
    doc_ok "Disk ${used}% used ($(oe_disk_free_gb .) GB free)"
  fi
  if oe_git_dirty; then
    doc_warn "Uncommitted changes in the checkout — deploy.sh will refuse to run"
  fi

  if oe_docker_running; then
    ui_header "Stack"
    local svc running
    running=$(oe_prod ps --status running --format '{{.Service}}' 2>/dev/null || true)
    ok=1
    for svc in nginx web ws-backend postgres redis cap; do
      if ! printf '%s\n' "$running" | grep -qx "$svc"; then
        doc_fail "Service $svc is not running"
        ok=0
      fi
    done
    [ "$ok" -eq 1 ] && doc_ok "nginx, web, ws-backend, postgres, redis, cap running"

    if [ -n "$domain" ] && curl -fsk --noproxy "*" --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" >/dev/null 2>&1; then
      doc_ok "Health endpoint answers"
    else
      doc_fail "https://$domain/api/health doesn't answer through nginx"
    fi

    # Same guard as scripts/deploy.sh.
    if docker volume inspect openexam-prod_redis_data >/dev/null 2>&1 \
      && ! docker volume inspect openexam-prod_valkey_data >/dev/null 2>&1; then
      doc_fail "Valkey migration hasn't run — see DEPLOYMENT.md (scripts/valkey-migrate.sh)"
    fi

    # Same check as the end of scripts/deploy.sh.
    site_key=$(env_get NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "$PROD_ENV" | cut -d/ -f3)
    if printf '%s\n' "$running" | grep -qx redis; then
      # grep without -q reads to the end: an early exit would SIGPIPE
      # valkey-cli and pipefail would turn a hit into a miss.
      if oe_prod exec -T redis valkey-cli --scan --pattern "cap:key:*" 2>/dev/null | grep -x "cap:key:$site_key" >/dev/null; then
        doc_ok "Captcha site key registered"
      else
        doc_fail "Captcha site key $site_key isn't registered — ./scripts/create-cap-site-key.sh && ./scripts/deploy.sh"
      fi
    fi
  fi

  ui_header "DNS and TLS"
  if [ -n "$domain" ]; then
    local dns_out
    if dns_out=$(./scripts/check-dns.sh 2>&1); then
      doc_ok "$dns_out"
    else
      doc_warn "$(printf '%s' "$dns_out" | head -n 1)"
    fi
  fi
  days=$(oe_cert_days_left "$CERT_LIVE/fullchain.pem")
  if [ -z "$days" ]; then
    doc_fail "No certificate at $CERT_LIVE"
  elif oe_cert_self_signed "$CERT_LIVE/fullchain.pem"; then
    doc_warn "Temporary self-signed certificate — ./scripts/issue-cert.sh once DNS points here"
  elif [ "$days" -lt 14 ]; then
    doc_fail "Certificate expires in $days days — is the renewal cron running? (./scripts/issue-cert.sh)"
  else
    doc_ok "Certificate valid for $days more days"
  fi

  ui_header "Backups"
  local cron newest age
  cron=$(crontab -l 2>/dev/null || true)
  if printf '%s\n' "$cron" | grep -qF "$OE_ROOT/scripts/backup.sh"; then doc_ok "Daily backup cron installed"; else doc_fail "No backup cron job (./scripts/install-cron.sh)"; fi
  if printf '%s\n' "$cron" | grep -qF "cd $PWD && docker compose -f docker-compose.prod.yml --env-file .env.prod --profile certbot run"; then doc_ok "Certificate renewal cron installed"; else doc_fail "No certificate renewal cron (./scripts/install-cron.sh)"; fi
  newest=$(ls -1t backups/openexam-*.dump 2>/dev/null | head -n 1 || true)
  if [ -z "$newest" ]; then
    doc_warn "No dumps in ./backups yet"
  else
    age=$(oe_file_age_hours "$newest")
    if [ "$age" -gt 36 ]; then doc_fail "Newest dump is $age hours old — check logs/openexam-backup.log"; else doc_ok "Newest dump is $age hours old"; fi
  fi
  if [ -s .rclone.conf ]; then
    if printf '%s\n' "$cron" | grep -qF "$OE_ROOT/scripts/offsite.sh"; then doc_ok "Offsite backups configured"; else doc_warn "Offsite target configured but no cron (./scripts/install-cron.sh)"; fi
  else
    doc_warn "No offsite backups — a dead disk loses everything (./openexam backup-offsite)"
  fi

  if [ -n "$smtp_to" ]; then
    ui_header "Email"
    # shellcheck source=scripts/cli/install.sh
    . scripts/cli/install.sh
    if ui_run "Sending a test email to $smtp_to" oe_smtp_test "$smtp_to"; then
      doc_ok "Test email sent"
    else
      doc_fail "SMTP test failed (details above)"
    fi
  fi
}

doctor_local() {
  local major
  ui_header "Development environment"
  if oe_docker_running; then doc_ok "Docker $(oe_docker_version)"; else doc_fail "Docker isn't running"; fi
  major=$(oe_node_major)
  if [ -n "$major" ] && [ "$major" -ge 26 ]; then doc_ok "Node $(node --version)"; else doc_fail "Node 26+ required (found: ${major:-none})"; fi
  if oe_has pnpm; then doc_ok "pnpm $(oe_pnpm_version)"; else doc_fail "pnpm missing"; fi
  if [ -f "$DEV_ENV" ]; then
    local var missing=""
    for var in DATABASE_URL BETTER_AUTH_SECRET MATCHING_ID_SECRET TEACHER_ACCESS_CODE; do
      env_is_placeholder "$(env_get "$var" "$DEV_ENV")" && missing="$missing $var"
    done
    if [ -n "$missing" ]; then doc_fail ".env lacks:$missing (./openexam install local fills them in)"; else doc_ok ".env complete"; fi
  else
    doc_fail "No .env (./openexam install local)"
  fi
  if [ -d node_modules ]; then doc_ok "Dependencies installed"; else doc_warn "node_modules missing (pnpm install)"; fi
  if oe_docker_running; then
    local running svc ok=1
    running=$(oe_dev ps --status running --format '{{.Service}}' 2>/dev/null || true)
    for svc in postgres redis ws-backend cap; do
      printf '%s\n' "$running" | grep -qx "$svc" || { doc_warn "Dev service $svc not running (./openexam dev starts it)"; ok=0; }
    done
    [ "$ok" -eq 1 ] && doc_ok "Dev services running"
  fi
}

cmd_doctor() {
  local mode="" smtp_to=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --local) mode=local ;;
      --smtp)
        if [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then smtp_to="$2"; shift; else smtp_to=default; fi
        ;;
      -h | --help) doctor_usage; return 0 ;;
      *) ui_die "Unknown option: $1 (see ./openexam doctor --help)" ;;
    esac
    shift
  done
  if [ -z "$mode" ]; then
    if [ -f "$PROD_ENV" ]; then mode=prod; else mode=local; fi
  fi

  ui_banner "doctor ($( [ "$mode" = prod ] && echo production || echo development))"
  if [ "$mode" = prod ]; then
    oe_require_prod_env
    if [ "$smtp_to" = default ]; then
      smtp_to=$(env_get ACME_EMAIL "$PROD_ENV")
      [ -n "$smtp_to" ] || smtp_to="admin@$(oe_domain)"
    fi
    doctor_prod "$smtp_to"
  else
    doctor_local
  fi

  echo
  if [ "$DOCTOR_FAILS" -gt 0 ]; then
    ui_err "$DOCTOR_FAILS problem(s), $DOCTOR_WARNS warning(s)"
    exit 1
  fi
  ui_ok "No problems found ($DOCTOR_WARNS warning(s))"
}

# ── uninstall ───────────────────────────────────────────────────────────────

uninstall_usage() {
  cat <<EOF
Usage: ./openexam uninstall [--purge [--no-backup]]

Stops and removes the containers, this install's cron jobs and the 80/443
firewall rule (SSH stays allowed). Keeps the data volumes, .env.prod,
./backups, certificates and .rclone.conf — reinstalling picks up where it was.

  --purge        Also delete the data volumes and images (asks twice; takes
                 a final backup into ./backups first)
  --no-backup    With --purge: skip that final backup
EOF
}

# Drops every crontab line that belongs to this checkout, plus the comment
# lines install-cron.sh / setup-monitoring.sh put above them.
oe_remove_cron() {
  local current
  current=$(crontab -l 2>/dev/null || true)
  [ -n "$current" ] || return 0
  # grep -v exits 1 when it removes every line — that's success here.
  printf '%s\n' "$current" \
    | { grep -vF "$OE_ROOT" || true; } \
    | { grep -vE '^# (certificate renewal, twice daily|daily database backup|daily offsite copy)' || true; } \
    | crontab -
}

oe_remove_firewall() {
  oe_has ufw || return 0
  local ssh
  ssh=$(oe_ssh_port)
  # configure-firewall.sh added one combined rule; keep SSH reachable first.
  oe_as_root ufw allow "$ssh/tcp" >/dev/null
  oe_as_root ufw delete allow "$ssh,80,443/tcp" >/dev/null 2>&1 || true
  oe_as_root ufw delete allow 80,443/tcp >/dev/null 2>&1 || true
}

cmd_uninstall() {
  local purge=0 backup=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge) purge=1 ;;
      --no-backup) backup=0 ;;
      -h | --help) uninstall_usage; return 0 ;;
      *) ui_die "Unknown option: $1 (see ./openexam uninstall --help)" ;;
    esac
    shift
  done
  oe_require_prod_env
  local domain
  domain=$(oe_domain)
  ui_banner "uninstall — $domain"

  ui_info "This will stop and remove all OpenExam containers, remove this install's"
  ui_info "cron jobs and close ports 80/443 in ufw (SSH stays open)."
  if [ "$purge" -eq 1 ]; then
    printf '  %s%s --purge: the database, Valkey and WAL archive volumes are DELETED too.%s\n' "$C_BOLD" "$C_RED" "$C_RESET"
  else
    ui_info "Kept: data volumes, .env.prod, ./backups, certs/, .rclone.conf."
  fi
  echo
  ui_type_to_confirm "$domain" "Uninstall OpenExam from this server?" || ui_die "Not confirmed — nothing changed."
  if [ "$purge" -eq 1 ]; then
    OE_CONFIRM="${OE_CONFIRM_PURGE:-}" ui_type_to_confirm "delete all data" "Last chance: every exam, answer and account on this server will be gone." \
      || ui_die "Not confirmed — nothing changed."
    if [ "$backup" -eq 1 ]; then
      ui_run "Final backup into ./backups" ./scripts/backup.sh || ui_die "Final backup failed — aborting (use --no-backup to skip)."
      if [ -s .rclone.conf ]; then
        ui_run "Pushing the final backup offsite" ./scripts/offsite.sh push --fresh || ui_warn "Offsite push failed."
      fi
    fi
  fi

  if [ "$purge" -eq 1 ]; then
    ui_run "Removing containers, volumes and images" \
      oe_prod --profile certbot --profile monitoring down --remove-orphans --volumes --rmi all || ui_die "docker compose down failed."
    docker images --format '{{.Repository}}:{{.Tag}}' | grep '^openexam-' | xargs -r docker rmi >> "$OE_LOG" 2>&1 || true
  else
    ui_run "Removing containers" oe_prod --profile certbot --profile monitoring down --remove-orphans || ui_die "docker compose down failed."
  fi
  ui_run "Removing cron jobs" oe_remove_cron || ui_warn "Couldn't edit the crontab."
  ui_run "Closing ports 80/443 in ufw" oe_remove_firewall || ui_warn "Couldn't update ufw."

  echo
  ui_ok "OpenExam is uninstalled."
  ui_dim ".env.prod is still here$( [ "$purge" -eq 1 ] && echo " — keep it with ./backups: restored data needs its keys")."
  ui_dim "Reinstall any time with ./openexam install."
}
