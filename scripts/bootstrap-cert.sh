#!/usr/bin/env bash
# Create a self-signed placeholder cert at certs/live/openexam so nginx can
# start before the real Let's Encrypt cert exists (scripts/deploy.sh refuses
# to run without one). Replace it with scripts/issue-cert.sh once the domain's
# DNS points at this host. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (scripts/gen-env-prod.sh)"; exit 1; }

if [ -f certs/live/openexam/fullchain.pem ]; then
  echo "cert already present: certs/live/openexam/fullchain.pem"
  exit 0
fi

mkdir -p certs/live/openexam
openssl req -x509 -nodes -newkey rsa:2048 -days 3 \
  -keyout certs/live/openexam/privkey.pem \
  -out certs/live/openexam/fullchain.pem \
  -subj "/CN=$(grep ^DOMAIN .env.prod | cut -d= -f2)" 2>/dev/null

echo "Self-signed placeholder cert at certs/live/openexam/ (3-day validity)."
echo "Replace it once DNS points here: ./scripts/issue-cert.sh"
