#!/usr/bin/env bash
# One-command bring-up for the OPT-IN monitoring stack (Prometheus, Grafana,
# Alertmanager, node/postgres/redis/nginx-exporter, GlitchTip, PITR cron) —
# see DEPLOYMENT.md's "Monitoring & Alerting" section for the full picture.
#
# Deliberately NOT part of scripts/setup-prod.sh's chain: that script brings
# up the exam stack itself (TLS, CAPTCHA, cron, firewall); this is a
# separate, independently-invocable concern, same as scripts/backup.sh is
# separate from scripts/deploy.sh. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/production-compose.sh
# Every monitoring service sits behind the `monitoring` profile
# (docker-compose.prod.yml), so it is never started by a plain `up`.
COMPOSE+=(--profile monitoring)

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (copy .env.example)"; exit 1; }

# shellcheck disable=SC1091
set -a
source .env.prod
set +a

placeholder_re='^(change-me|)$'

require_set() {
  local name="$1" value="${!1:-}"
  if [[ "$value" =~ $placeholder_re ]]; then
    echo "ERROR: $name is not set (or still the .env.example placeholder) in .env.prod" >&2
    exit 1
  fi
}

for var in GRAFANA_ADMIN_PASSWORD GLITCHTIP_SECRET_KEY GLITCHTIP_DB_PASSWORD \
           MONITORING_DB_PASSWORD \
           ALERT_EMAIL_TO; do
  require_set "$var"
done


mkdir -p monitoring-data/textfile-collector
chmod 755 monitoring-data/textfile-collector
source scripts/lib/pitr-state.sh

# Alertmanager has no env-var interpolation, so its config is rendered from
# the committed template rather than read directly (unlike nginx's envsubst,
# which runs inside that container at start — this runs on the host instead,
# once, since Alertmanager's image has no equivalent templating step). Not
# using `envsubst` (not guaranteed present on every host) — a small,
# variable-scoped sed substitution instead, which also avoids the arbitrary
# code execution risk of an `eval`-based approach.
render_var() {
  local name="$1" file="$2" escaped
  # Escape every sed-special character in the replacement, not just / and &:
  # an SMTP_PASSWORD containing |, \ or a newline would otherwise corrupt
  # the rendered config. Newlines are flattened to a literal \n first (then
  # re-escaped) so a multi-line value can't break the sed expression.
  escaped=$(printf '%s' "${!1:-}" \
    | sed -e ':a' -e 'N' -e '$!ba' -e 's/\r//g' -e 's/\n/\\n/g' \
          -e 's/\\/\\\\/g' \
          -e 's/&/\\&/g' \
          -e 's/|/\\|/g')
  sed -i "s|\${$name}|$escaped|g" "$file"
}

am_out="monitoring/alertmanager/alertmanager.yml"
umask 077
cp monitoring/alertmanager/alertmanager.yml.tmpl "$am_out"
for var in SMTP_HOST SMTP_PORT SMTP_FROM SMTP_USER SMTP_PASSWORD SMTP_SECURE ALERT_EMAIL_TO; do
  render_var "$var" "$am_out"
done
chmod 600 "$am_out"

# The cap-probe blackbox target carries the deployed Cap site key, which is
# generated per installation (scripts/create-cap-site-key.sh) and rotated by
# that same script. Committing it as a literal in prometheus.yml would alert
# CapChallengeFailing on every host whose key differs, so generate it here from
# the one variable that already holds it. Prometheus re-reads file_sd targets
# on its own, so a later rotation needs no reload — but re-run this script (or
# just regenerate this file) after rotating.
cap_site_key=$(printf '%s' "${NEXT_PUBLIC_CAP_WIDGET_ENDPOINT:-}" \
  | tr '/' '\n' | grep -v '^$' | tail -n1)
if [ -z "$cap_site_key" ] || [ "$cap_site_key" = "change-me" ]; then
  echo "ERROR: could not derive the Cap site key from NEXT_PUBLIC_CAP_WIDGET_ENDPOINT" >&2
  echo "       in .env.prod (got '${NEXT_PUBLIC_CAP_WIDGET_ENDPOINT:-<unset>}')." >&2
  echo "       Run scripts/create-cap-site-key.sh first." >&2
  exit 1
fi
mkdir -p monitoring/prometheus/targets
cat > monitoring/prometheus/targets/cap-probe.json <<JSON
[
  {
    "targets": ["http://cap:3000/${cap_site_key}/challenge"],
    "labels": { "service": "cap" }
  }
]
JSON
chmod 644 monitoring/prometheus/targets/cap-probe.json
echo "Wrote monitoring/prometheus/targets/cap-probe.json (site key ${cap_site_key})."

echo "Bringing up the monitoring stack..."
"${COMPOSE[@]}" up -d --build \
  monitoring-db-init \
  node-exporter postgres-exporter redis-exporter nginx-exporter nginx-log-exporter \
  blackbox-exporter prometheus alertmanager grafana \
  glitchtip-migrate glitchtip-web glitchtip-worker

# Independent of scripts/install-cron.sh's own idempotency check (which only
# greps for scripts/backup.sh) — this installs its own two lines and checks
# for them by their own distinct commands, so re-running either script never
# duplicates the other's cron line.
repo_dir="$(pwd)"
install_cron_line() {
  local line="$1"
  ( crontab -l 2>/dev/null | grep -vF "$line" ; echo "$line" ) | crontab -
}
install_cron_line "0 4 * * * $repo_dir/scripts/pitr-backup.sh >> /var/log/openexam-pitr-backup.log 2>&1"
install_cron_line "17 5 * * * $repo_dir/scripts/cert-expiry-metric.sh >> /var/log/openexam-cert-expiry.log 2>&1"

cat <<EOF

Monitoring stack is up. Dashboards are internal-only — reach them via SSH tunnel:
  ssh -L 9090:localhost:9090 -L 9093:localhost:9093 -L 3001:localhost:3001 -L 8001:localhost:8001 <user>@<host>
  Prometheus:   http://localhost:9090
  Alertmanager: http://localhost:9093
  Grafana:      http://localhost:3001  (login: admin / \$GRAFANA_ADMIN_PASSWORD)
  GlitchTip:    http://localhost:8001  (open registration is disabled — create
                the admin user in the container first, then log in and create
                the project:
                  $COMPOSE_CMD \
                    exec glitchtip-web python manage.py createsuperuser
                then set SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN in .env.prod to its
                DSN — see DEPLOYMENT.md — and redeploy: ./scripts/deploy.sh)

The PITR cron runs daily at 4am and skips when WALG_STORAGE_BACKEND=disabled.
Run a restore drill before you need one for real — DEPLOYMENT.md's
"Point-in-time recovery" section has the procedure.
EOF
