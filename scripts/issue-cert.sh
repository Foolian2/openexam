#!/usr/bin/env bash
# Issue (or renew) the Let's Encrypt certificate via webroot through nginx and
# reload nginx. Idempotent: certbot does nothing when the cert has >30 days
# left, and re-issues when it hasn't been generated at all yet.
#
# Handles the placeholder transition cleanly: if certs/live/openexam holds a
# self-signed cert (issuer == subject), it is moved aside before issuance so
# certbot writes live/openexam itself instead of tripping its "live directory
# exists" conflict and parking the real cert in a stray live/openexam-0002
# (the path nginx hardcodes would then keep serving the placeholder). If
# issuance fails, the placeholder is restored.
#
# Requires the stack to be up (nginx serves the ACME challenge on port 80)
# and the domain's A/AAAA record to point at this host.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/production-compose.sh
[ -f .env.prod ] || { echo "ERROR: .env.prod missing (scripts/gen-env-prod.sh)"; exit 1; }
DOMAIN=$(grep ^DOMAIN= .env.prod | cut -d= -f2)
[ -n "$DOMAIN" ] || { echo "ERROR: DOMAIN not set in .env.prod"; exit 1; }
# Where Let's Encrypt sends expiry warnings. Falls back to admin@DOMAIN for
# .env.prod files from before ACME_EMAIL existed.
ACME_EMAIL=$(grep ^ACME_EMAIL= .env.prod | cut -d= -f2- || true)
ACME_EMAIL="${ACME_EMAIL:-admin@$DOMAIN}"

# Fail fast with a clear message instead of certbot's opaque "DNS problem"
# errors: the ACME webroot challenge must reach THIS host.
if ! ./scripts/check-dns.sh; then
  exit 1
fi

live=certs/live/openexam
restore_placeholder=

if [ -f "$live/fullchain.pem" ]; then
  issuer=$(openssl x509 -in "$live/fullchain.pem" -noout -issuer 2>/dev/null | cut -d= -f2-)
  subject=$(openssl x509 -in "$live/fullchain.pem" -noout -subject 2>/dev/null | cut -d= -f2-)
  if [ "$issuer" = "$subject" ]; then
    echo "Existing cert is self-signed — moving it aside so certbot owns $live"
    mv "$live" "$live.placeholder"
    restore_placeholder=1
  fi
fi

run_certbot() {
  if [ -f certs/renewal/openexam.conf ]; then
    # Existing renewal config: `renew` is non-interactive and skips entirely
    # when the cert has >30 days left (same semantics as the cron job).
    "${COMPOSE[@]}" --profile certbot run --rm certbot renew \
      --cert-name openexam --webroot -w /var/www/certbot
  else
    # First issuance: --non-interactive with --keep-until-expiring makes a
    # pre-existing cert a no-op instead of certbot's interactive
    # "Renew & replace?" prompt (which hangs unattended runs).
    "${COMPOSE[@]}" --profile certbot run --rm certbot certonly \
      --non-interactive --keep-until-expiring --agree-tos \
      --webroot -w /var/www/certbot --cert-name openexam -d "$DOMAIN" \
      --email "$ACME_EMAIL"
  fi
}

if ! run_certbot; then
  if [ -n "$restore_placeholder" ] && [ ! -f "$live/fullchain.pem" ]; then
    mv "$live.placeholder" "$live"
    echo "certbot failed (is DNS pointing here yet?) — restored the placeholder cert" >&2
  fi
  exit 1
fi

if [ -n "$restore_placeholder" ]; then
  rm -rf "$live.placeholder"
fi

"${COMPOSE[@]}" exec nginx nginx -s reload
echo "Let's Encrypt cert for $DOMAIN in place; nginx reloaded."
