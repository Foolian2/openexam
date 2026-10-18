# shellcheck shell=bash
# ./openexam backup | restore | backup-offsite

RCLONE_CONF=.rclone.conf

backup_usage() {
  cat <<EOF
Usage: ./openexam backup

Dumps the database now (scripts/backup.sh, into ./backups) and, when an
offsite target is configured, pushes it there right away.
EOF
}

restore_usage() {
  cat <<EOF
Usage: ./openexam restore [FILE] [--from-offsite]

Replaces the production database with a pg_dump. Without FILE, pick one of
the local dumps in ./backups (or, with --from-offsite, one from the offsite
target). Takes a safety dump of the current database first, restores in a
single transaction (all or nothing), and asks you to type the domain first.

Non-interactive: OE_CONFIRM=<domain> ./openexam restore FILE --yes
EOF
}

offsite_usage() {
  cat <<EOF
Usage: ./openexam backup-offsite

Sets up (or replaces) the offsite target for the daily dumps and .env.prod:
S3-compatible storage, Backblaze B2, SFTP (e.g. Hetzner Storage Box) or a
directory on this server (a mounted NAS). Encrypted client-side by default.
Pushes once, verifies the copy, and installs the 03:15 cron job.

Unattended: preset OFF_TYPE (s3|b2|sftp|local) and its OFF_* values (see
scripts/cli/backup.sh) in the environment and pass --yes.
EOF
}

oe_offsite_configured() { [ -s "$RCLONE_CONF" ]; }

# ── offsite setup ───────────────────────────────────────────────────────────

# Asks where offsite copies go. Sets OFF_TYPE and the OFF_* values for it.
# Every answer can be preset in the environment for unattended runs:
# OFF_TYPE (s3|b2|sftp|local), OFF_ENDPOINT, OFF_REGION, OFF_BUCKET,
# OFF_KEY_ID, OFF_SECRET, OFF_HOST, OFF_PORT, OFF_USER, OFF_PATH,
# OFF_PASSPHRASE (to reuse an existing passphrase instead of a new one).
oe_offsite_ask() {
  [ -n "${OFF_TYPE:-}" ] || ui_select OFF_TYPE "Where should offsite backups go?" 0 \
    "s3|S3-compatible storage|AWS, Hetzner Object Storage, Wasabi, MinIO, …" \
    "b2|Backblaze B2|" \
    "sftp|SFTP server|e.g. Hetzner Storage Box" \
    "local|A directory on this server|a mounted NAS or second disk — not offsite by itself"
  case "$OFF_TYPE" in
    s3)
      ui_ask OFF_ENDPOINT "S3 endpoint URL" "${OFF_ENDPOINT:-https://fsn1.your-objectstorage.com}"
      ui_ask OFF_REGION "Region" "${OFF_REGION:-us-east-1}"
      ui_ask OFF_BUCKET "Bucket (and optional /prefix)" "${OFF_BUCKET:-}"
      ui_ask OFF_KEY_ID "Access key ID" "${OFF_KEY_ID:-}"
      [ -n "${OFF_SECRET:-}" ] || ui_secret OFF_SECRET "Secret access key" 0 1 "OFF_SECRET"
      OFF_PATH="$OFF_BUCKET"
      ;;
    b2)
      ui_ask OFF_BUCKET "Bucket (and optional /prefix)" "${OFF_BUCKET:-}"
      ui_ask OFF_KEY_ID "Application key ID" "${OFF_KEY_ID:-}"
      [ -n "${OFF_SECRET:-}" ] || ui_secret OFF_SECRET "Application key" 0 1 "OFF_SECRET"
      OFF_PATH="$OFF_BUCKET"
      ;;
    sftp)
      ui_ask OFF_HOST "SFTP host" "${OFF_HOST:-}"
      ui_ask OFF_PORT "Port (Hetzner Storage Box: 23)" "${OFF_PORT:-22}" oe_valid_port
      ui_ask OFF_USER "User" "${OFF_USER:-}"
      ui_ask OFF_PATH "Directory on the server" "${OFF_PATH:-openexam-backups}"
      local auth=password
      [ -n "${OFF_KEY_FILE:-}" ] && auth=key
      [ -n "${OFF_KEY_FILE:-}${OFF_SECRET:-}" ] || ui_select auth "Log in with" 0 \
        "password|Password|" \
        "key|SSH private key file|unencrypted key, e.g. ~/.ssh/id_ed25519"
      if [ "$auth" = key ]; then
        local key_file
        ui_ask key_file "Path to the private key" "${OFF_KEY_FILE:-$HOME/.ssh/id_ed25519}"
        [ -r "$key_file" ] || ui_die "Can't read $key_file"
        OFF_KEY_PEM=$(awk '{ printf "%s\\n", $0 }' "$key_file")
        OFF_SECRET=""
      else
        [ -n "${OFF_SECRET:-}" ] || ui_secret OFF_SECRET "Password" 0 1 "OFF_SECRET"
        OFF_KEY_PEM=""
      fi
      ;;
    local)
      ui_ask OFF_PATH "Absolute directory path" "${OFF_PATH:-/mnt/backup/openexam}"
      case "$OFF_PATH" in /*) ;; *) ui_die "Use an absolute path." ;; esac
      ;;
  esac
}

# rclone stores passwords obscured (reversible, but not plain text in the
# file). Piped through stdin so the secret never lands in argv or the log.
oe_rclone_obscure() {
  printf '%s' "$1" | ./scripts/offsite.sh rclone obscure -
}

# Writes .rclone.conf for the OFF_* answers. $1 is the crypt passphrase
# (empty: no encryption).
oe_offsite_write_conf() {
  local passphrase="$1" tmp
  tmp=$(mktemp "$RCLONE_CONF.XXXXXX")
  # Keep the working config until the new one is verified (see
  # oe_offsite_first_push); offsite.sh needs a config file to exist even to
  # run `obscure`.
  rm -f "$RCLONE_CONF.prev"
  if [ -f "$RCLONE_CONF" ]; then
    (umask 077 && cp -p "$RCLONE_CONF" "$RCLONE_CONF.prev")
  else
    (umask 077 && : > "$RCLONE_CONF")
  fi
  {
    echo "# Offsite backup target — written by ./openexam backup-offsite."
    echo "# Used by scripts/offsite.sh. Contains credentials: keep it chmod 600."
    [ "$OFF_TYPE" = local ] && echo "# openexam-local-path: $OFF_PATH"
    echo
    echo "[offsite-target]"
    case "$OFF_TYPE" in
      s3)
        echo "type = s3"
        echo "provider = Other"
        echo "access_key_id = $OFF_KEY_ID"
        echo "secret_access_key = $OFF_SECRET"
        echo "endpoint = $OFF_ENDPOINT"
        echo "region = $OFF_REGION"
        echo "no_check_bucket = true"
        ;;
      b2)
        echo "type = b2"
        echo "account = $OFF_KEY_ID"
        echo "key = $OFF_SECRET"
        ;;
      sftp)
        echo "type = sftp"
        echo "host = $OFF_HOST"
        echo "user = $OFF_USER"
        echo "port = $OFF_PORT"
        if [ -n "$OFF_KEY_PEM" ]; then
          echo "key_pem = $OFF_KEY_PEM"
        else
          echo "pass = $(oe_rclone_obscure "$OFF_SECRET")"
        fi
        ;;
      local)
        echo "type = local"
        ;;
    esac
    echo
    echo "[offsite]"
    if [ -n "$passphrase" ]; then
      echo "type = crypt"
      echo "remote = offsite-target:$OFF_PATH"
      echo "password = $(oe_rclone_obscure "$passphrase")"
      echo "filename_encryption = standard"
      echo "directory_name_encryption = true"
    else
      echo "type = alias"
      echo "remote = offsite-target:$OFF_PATH"
    fi
  } > "$tmp"
  cat "$tmp" > "$RCLONE_CONF"
  rm -f "$tmp"
  chmod 600 "$RCLONE_CONF"
}

# Shows the generated crypt passphrase once and makes sure it was stored.
oe_offsite_show_passphrase() {
  local passphrase="$1"
  echo
  printf '  %s%s Offsite encryption passphrase — store it in your password manager NOW:%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
  printf '\n      %s%s%s\n\n' "$C_BOLD" "$passphrase" "$C_RESET"
  ui_dim "Without it the offsite copies can't be decrypted. It is NOT shown again;"
  ui_dim "this server keeps it only (obscured) in .rclone.conf, which dies with the server."
  if ui_interactive; then
    until ui_confirm "I have stored the passphrase somewhere other than this server" n; do
      ui_warn "Please store it first — a lost server with a lost passphrase means no recovery."
    done
  fi
}

# Push + verify + cron. Assumes .rclone.conf is written. When the new target
# fails verification the previous config (if any) is put back.
oe_offsite_first_push() {
  if oe_offsite_verify_push; then
    rm -f "$RCLONE_CONF.prev"
    return 0
  fi
  if [ -f "$RCLONE_CONF.prev" ]; then
    mv "$RCLONE_CONF.prev" "$RCLONE_CONF"
    ui_warn "Kept the previous offsite configuration."
  fi
  return 1
}

oe_offsite_verify_push() {
  if ls backups/openexam-*.dump >/dev/null 2>&1; then
    :
  else
    ui_run "Taking a first database dump" ./scripts/backup.sh || return 1
  fi
  ui_run "Pushing dumps and .env.prod offsite" ./scripts/offsite.sh push --fresh || return 1
  local listing
  listing=$(./scripts/offsite.sh list 2>>"$OE_LOG" | head -n 1)
  if [ -n "$listing" ]; then
    ui_ok "Verified: newest offsite dump is ${listing%%;*}"
  else
    ui_err "The push reported success but no dump is listed offsite."
    return 1
  fi
  ui_run "Installing the daily offsite cron job (03:15)" ./scripts/install-cron.sh
}

# The whole backup-offsite flow. $1=1 when called from install (no banner).
oe_offsite_setup() {
  local embedded="${1:-0}" passphrase="" encrypt=1
  if [ "$embedded" -eq 0 ]; then
    ui_banner "offsite backups"
    oe_require_prod_env
    if oe_offsite_configured; then
      ui_confirm "An offsite target is already configured. Replace it?" n || return 0
    fi
  fi
  oe_offsite_ask
  if ! ui_confirm "Encrypt backups before they leave the server? (strongly recommended)" y; then
    encrypt=0
    ui_warn "Unencrypted: whoever can read the target can read every student's data and every secret."
  fi
  if [ "$encrypt" -eq 1 ]; then
    passphrase="${OFF_PASSPHRASE:-$(oe_secret_alnum 32)}"
  fi
  oe_offsite_write_conf "$passphrase"
  ui_ok "Wrote $RCLONE_CONF (chmod 600)"
  [ "$encrypt" -eq 1 ] && [ -z "${OFF_PASSPHRASE:-}" ] && oe_offsite_show_passphrase "$passphrase"
  return 0
}

# ── commands ────────────────────────────────────────────────────────────────

cmd_backup_offsite() {
  case "${1:-}" in -h | --help) offsite_usage; return 0 ;; esac
  oe_offsite_setup 0
  oe_offsite_first_push || ui_die "Offsite push failed — check the target settings and run ./openexam backup-offsite again."
}

cmd_backup() {
  case "${1:-}" in -h | --help) backup_usage; return 0 ;; esac
  oe_require_prod_env
  ui_banner "backup"
  ui_run "Dumping the database" ./scripts/backup.sh || exit 1
  ui_dim "$(grep '^OK: ' "$OE_LOG" | tail -n 1)"
  if oe_offsite_configured; then
    ui_run "Pushing offsite" ./scripts/offsite.sh push --fresh || exit 1
  else
    ui_warn "No offsite target — this dump only exists on this server. Set one up: ./openexam backup-offsite"
  fi
}

# Restores $1 into the running postgres, all or nothing. The archive is
# rendered to plain SQL and applied by psql in ONE transaction that first
# drops and recreates the public schema: pg_restore --clean only drops the
# objects that are in the archive, so a dump from before a migration would
# leave that migration's newer tables and enums behind.
oe_pg_restore() (
  # Plain-SQL rendering can be larger than the archive itself; spool it
  # somewhere with room (OE_RESTORE_SPOOL_DIR, e.g. the backups volume)
  # instead of relying on /tmp having space.
  local spool_dir="${OE_RESTORE_SPOOL_DIR:-${TMPDIR:-/tmp}}"
  local sql
  sql=$(mktemp "$spool_dir/openexam-restore-sql.XXXXXX") || return 1
  cleanup() { rm -f -- "$sql"; }
  trap cleanup EXIT
  # Belt and braces for an interrupted restore: bash already runs the EXIT
  # trap on fatal signals, but a trapped signal is deferred until the
  # current foreground command (pg_restore/psql) finishes, so keep both the
  # unconditional EXIT cleanup and an explicit exit status per signal
  # (128 + signo: 130 for INT, 143 for TERM).
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM
  # A failed producer cannot roll back a consumer that already committed
  # valid DROP/CREATE statements. Finish the entire SQL file before psql;
  # cleanup removes it again on every exit path, spool left empty.
  printf 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n' > "$sql" || return 1
  if ! oe_prod exec -T postgres pg_restore -U openexam --no-owner -f - < "$1" >> "$sql"; then
    echo "ERROR: pg_restore failed; restore aborted before any change." >&2
    return 1
  fi
  oe_prod exec -T postgres psql -U openexam -d openexam \
    -v ON_ERROR_STOP=1 --single-transaction -f - -q -o /dev/null < "$sql"
)

oe_health_check() {
  local domain="$1"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsk --noproxy "*" --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

cmd_restore() {
  local file="" from_offsite=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --from-offsite) from_offsite=1 ;;
      -h | --help) restore_usage; return 0 ;;
      -*) ui_die "Unknown option: $1 (see ./openexam restore --help)" ;;
      *) file="$1" ;;
    esac
    shift
  done

  oe_require_prod_env
  local domain
  domain=$(oe_domain)
  ui_banner "restore"
  [ -n "$(oe_prod ps -q postgres 2>/dev/null)" ] || ui_die "Postgres isn't running — start the stack first."

  if [ "$from_offsite" -eq 1 ]; then
    oe_offsite_configured || ui_die "No offsite target configured (./openexam backup-offsite)."
    local -a remote opts
    remote=()
    while IFS= read -r line; do remote+=("$line"); done < <(./scripts/offsite.sh list 2>>"$OE_LOG" | head -n 10)
    [ "${#remote[@]}" -gt 0 ] || ui_die "No dumps found offsite."
    opts=()
    for line in "${remote[@]}"; do
      opts+=("${line%%;*}|${line%%;*}|$(( ${line#*;} / 1024 / 1024 )) MB")
    done
    local pick
    ui_select pick "Which offsite dump?" 0 "${opts[@]}"
    ui_run "Downloading $pick" ./scripts/offsite.sh fetch "$pick" backups || exit 1
    file="backups/$pick"
  elif [ -z "$file" ]; then
    local -a dumps opts
    dumps=()
    while IFS= read -r line; do dumps+=("$line"); done < <(ls -1t backups/openexam-*.dump 2>/dev/null | head -n 10)
    [ "${#dumps[@]}" -gt 0 ] || ui_die "No dumps in ./backups — pass a file, or use --from-offsite."
    opts=()
    for line in "${dumps[@]}"; do
      opts+=("$line|$(basename "$line")|$(du -h "$line" | cut -f1)")
    done
    ui_select file "Which dump?" 0 "${opts[@]}"
  fi
  [ -s "$file" ] || ui_die "$file doesn't exist or is empty."

  ui_kv "Dump" "$file ($(du -h "$file" | cut -f1))"
  ui_kv "Into" "the openexam database on $domain"
  if crontab -l 2>/dev/null | grep -q pitr-backup.sh; then
    ui_dim "Need to rebuild from the wal-g base backup archive instead? See scripts/pitr-restore.sh (DEPLOYMENT.md)."
  fi
  echo
  ui_type_to_confirm "$domain" "This replaces ALL current data (exams, answers, accounts) with the dump." \
    || ui_die "Not confirmed — nothing changed."

  # Restore from a private copy: the safety dump below lands in the same
  # directory, and nothing it does may touch the file being restored.
  local source
  source=$(mktemp "${TMPDIR:-/tmp}/openexam-restore.XXXXXX")
  cp "$file" "$source"
  ui_run "Safety dump of the current database" ./scripts/backup.sh \
    || { rm -f "$source"; ui_die "Couldn't take the safety dump — aborting before touching anything."; }
  ui_dim "Saved as $(grep '^OK: ' "$OE_LOG" | tail -n 1 | cut -d' ' -f2)"
  ui_run "Stopping web and ws-backend" oe_prod stop web ws-backend || exit 1
  local restore_ok=1
  if ! ui_run "Restoring $file" oe_pg_restore "$source"; then
    restore_ok=0
    ui_warn "Restore failed — the database is unchanged (aborted before psql ran or rolled back in its transaction)."
  fi
  rm -f "$source"
  ui_run "Starting web and ws-backend" oe_prod up -d web ws-backend || exit 1
  # Replaced containers can get new IPs; nginx resolves them once at start.
  ui_run "Reloading nginx" oe_prod exec -T nginx nginx -s reload || true
  if oe_health_check "$domain"; then
    ui_ok "https://$domain is healthy"
  else
    ui_warn "Health check didn't pass yet — check ./openexam status"
  fi
  [ "$restore_ok" -eq 1 ] || ui_die "The restore did not happen: the dump was rejected and the database is unchanged."
}
