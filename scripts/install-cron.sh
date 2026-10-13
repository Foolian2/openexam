#!/usr/bin/env bash
# Install the production cron lines for the current user (idempotent):
#   - TLS cert renewal, twice daily (certbot renew only acts when <30 days left)
#   - daily PostgreSQL backup via scripts/backup.sh
#   - daily offsite push via scripts/offsite.sh, only once an offsite target
#     is configured (./openexam backup-offsite writes .rclone.conf)
# Run as the deploy user (the same one that will run scripts/deploy.sh).
#
# Each line is checked for on its own, so re-running after an offsite target
# was added later installs just that line and duplicates nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_DIR=$(pwd)

# Cron runs as this user, so the logs live where this user can write; a
# redirect into /var/log fails before the script even starts.
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

renewal_line="17 4,16 * * * cd $REPO_DIR && docker compose -f docker-compose.prod.yml --env-file .env.prod --profile certbot run --rm certbot renew --webroot -w /var/www/certbot && docker compose -f docker-compose.prod.yml --env-file .env.prod exec nginx nginx -s reload"
backup_line="0 3 * * * $REPO_DIR/scripts/backup.sh >> $LOG_DIR/openexam-backup.log 2>&1"
# 03:15: after the 03:00 dump; offsite.sh's own --min-age 1h guard means it
# ships the previous days' dumps plus any older than an hour, never a
# half-written one.
offsite_line="15 3 * * * $REPO_DIR/scripts/offsite.sh push >> $LOG_DIR/openexam-offsite.log 2>&1"

current=$(crontab -l 2>/dev/null || true)
added=0

add_line() {
  local marker="$1" comment="$2" line="$3"
  if printf '%s\n' "$current" | grep -qF "$marker"; then
    return 0
  fi
  current=$(printf '%s\n# %s\n%s' "$current" "$comment" "$line")
  added=$((added + 1))
}

add_line "$REPO_DIR && docker compose -f docker-compose.prod.yml --env-file .env.prod --profile certbot run" \
  "certificate renewal, twice daily (only renews when <30 days left)" "$renewal_line"
add_line "$REPO_DIR/scripts/backup.sh" \
  "daily database backup (PRD: daily backups; see scripts/backup.sh)" "$backup_line"
if [ -s .rclone.conf ]; then
  add_line "$REPO_DIR/scripts/offsite.sh" \
    "daily offsite copy of the dumps + .env.prod (see scripts/offsite.sh)" "$offsite_line"
fi

if [ "$added" -eq 0 ]; then
  echo "cron already installed — nothing to do."
  exit 0
fi

printf '%s\n' "$current" | sed '/./,$!d' | crontab -

echo "Installed $added cron job(s) for $(id -un):"
crontab -l | grep -E "certbot renew|backup.sh|offsite.sh"
