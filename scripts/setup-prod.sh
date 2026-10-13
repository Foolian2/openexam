#!/usr/bin/env bash
# One-command production bring-up (PRD §16.1 target: single Ubuntu server
# with Docker + Compose v2). From a bare clone on a fresh box:
#
#   ./scripts/setup-prod.sh openexam.ch
#
# This chains (each step also runnable on its own, all idempotent):
#   1. check-dns.sh          — does the domain's A record point at this host?
#   2. gen-env-prod.sh       — .env.prod with fresh random secrets
#   3. bootstrap-cert.sh     — self-signed placeholder so nginx can boot
#   4. deploy.sh             — build, migrate, roll the stack
#   5. create-cap-site-key.sh— Cap CAPTCHA site key via the admin API
#   6. deploy.sh             — rebake so the site key lands in the web image
#   7. issue-cert.sh         — real Let's Encrypt cert (only when DNS points
#                              here; skipped with a clear warning otherwise —
#                              re-run this script or issue-cert.sh later)
#   8. install-cron.sh       — cert renewal + daily backup cron lines
#   9. configure-firewall.sh — ufw: SSH port + 80/443, enabled
#
# Manual steps that cannot be scripted: point the domain's A/AAAA record at
# this host (do it before running, or run this script again once it
# propagates), fill the school's LEGAL_* details in .env.prod (the first run
# stops after generating it if they're empty — deploy.sh checks them), and
# optionally SMTP_*/Microsoft login values.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-}"

if [ -f .env.prod ]; then
  echo "Using existing .env.prod"
elif [ -n "$DOMAIN" ]; then
  ./scripts/gen-env-prod.sh "$DOMAIN"
else
  echo "ERROR: .env.prod missing — pass a domain: ./scripts/setup-prod.sh exam.example.com" >&2
  exit 1
fi

if ! grep -qE '^LEGAL_CONTROLLER_NAME=.+' .env.prod; then
  echo
  echo "Next: fill in the school's details for /datenschutz and /impressum in"
  echo ".env.prod (LEGAL_CONTROLLER_NAME, LEGAL_CONTROLLER_ADDRESS,"
  echo "LEGAL_CONTACT_EMAIL, LEGAL_HOSTING_PROVIDER), then re-run this script."
  exit 1
fi

if ./scripts/check-dns.sh; then
  dns_ready=1
else
  dns_ready=0
fi

./scripts/bootstrap-cert.sh
./scripts/deploy.sh
./scripts/create-cap-site-key.sh
./scripts/deploy.sh

if [ "$dns_ready" -eq 1 ]; then
  ./scripts/issue-cert.sh
else
  echo
  echo "DNS does not point at this host yet — the placeholder cert remains."
  echo "Once the A/AAAA record resolves here, run ./scripts/issue-cert.sh"
  echo "(or re-run this script)."
fi

./scripts/install-cron.sh
./scripts/configure-firewall.sh

issuer=$(openssl x509 -in certs/live/openexam/fullchain.pem -noout -issuer 2>/dev/null || true)
case "$issuer" in
  *"Let's Encrypt"*) tls="Let's Encrypt (real)" ;;
  *) tls="self-signed placeholder — run ./scripts/issue-cert.sh once DNS points here" ;;
esac

echo
echo "Setup complete: https://$(grep ^DOMAIN .env.prod | cut -d= -f2)"
echo "  - stack: $(docker compose -f docker-compose.prod.yml --env-file .env.prod ps --format '{{.Service}}' 2>/dev/null | tr '\n' ' ')"
echo "  - TLS:   $tls"
echo "  - cron:   $(crontab -l 2>/dev/null | grep -c '^0 3 .*backup.sh' || true) backup + $(crontab -l 2>/dev/null | grep -c 'certbot renew' || true) renewal job(s)"
echo "Optional: add SMTP_*/Microsoft values to .env.prod and re-run ./scripts/deploy.sh."
