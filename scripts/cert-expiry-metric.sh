#!/usr/bin/env bash
# Writes a node-exporter textfile-collector metric for days-until-TLS-cert-
# expiry, backing monitoring/prometheus/rules/alerts.yml's CertExpiringSoon
# alert. Installed to cron by scripts/setup-monitoring.sh, independently of
# the certbot-renewal cron line (DEPLOYMENT.md) — this only ever reads the
# cert, never renews it.
set -euo pipefail
cd "$(dirname "$0")/.."

cert="certs/live/openexam/fullchain.pem"
metrics_dir="monitoring-data/textfile-collector"

[ -f "$cert" ] || { echo "ERROR: no cert at $cert" >&2; exit 1; }
[ -d "$metrics_dir" ] || { echo "ERROR: $metrics_dir missing — run scripts/setup-monitoring.sh first" >&2; exit 1; }

end_date=$(openssl x509 -enddate -noout -in "$cert" | cut -d= -f2)
days_left=$(( ($(date -d "$end_date" +%s) - $(date +%s)) / 86400 ))

metrics_tmp="$(mktemp "$metrics_dir/.cert_expiry.XXXXXX")"
{
  echo "# HELP openexam_cert_expiry_days Days until the TLS certificate expires"
  echo "# TYPE openexam_cert_expiry_days gauge"
  echo "openexam_cert_expiry_days $days_left"
} > "$metrics_tmp"
chmod 644 "$metrics_tmp"
mv "$metrics_tmp" "$metrics_dir/cert_expiry.prom"

echo "OK: certificate expires in $days_left days"
