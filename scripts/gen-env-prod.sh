#!/usr/bin/env bash
# Generate .env.prod from .env.example with fresh random secrets, ready for
# docker-compose.prod.yml. Deliberately refuses to overwrite an existing
# .env.prod: secrets in it (DB password, at-rest key, Cap admin key, …) are
# not recoverable, and the DB volumes were initialized with the ones
# they hold — re-generating would silently break the stack.
#
# Usage: ./scripts/gen-env-prod.sh [domain]   (prompts for the domain if omitted)
#
# The monitoring secrets are generated too, although the monitoring stack is
# opt-in (scripts/setup-monitoring.sh): that script refuses placeholders, so
# turning it on later would otherwise mean hand-editing four secrets first.
#
# The Cap site key/secret are random placeholders here: the web tier must
# still boot env validation (CAP_SECRET_KEY min length), while the real
# values must be created in the cap service (scripts/create-cap-site-key.sh),
# which rewrites NEXT_PUBLIC_CAP_WIDGET_ENDPOINT / CAP_SECRET_KEY in this
# file.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-}"
while [ -z "$DOMAIN" ]; do
  read -rp "Domain (e.g. exam.example.com): " DOMAIN
done

[ -f .env.example ] || { echo "ERROR: .env.example missing"; exit 1; }
[ ! -f .env.prod ] || {
  echo "ERROR: .env.prod already exists — refusing to overwrite (it holds live secrets)"; exit 1
}

gen() { openssl rand -base64 32; }
alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }

cp .env.example .env.prod
chmod 600 .env.prod

# Values are base64/alnum/hex only — none contain the '|' sed delimiter.
# POSTGRES_PASSWORD must be alnum, not base64: docker-compose.prod.yml splices
# it unescaped into DATABASE_URL, and a base64 '/' (in about half of all
# 32-byte values) makes that URL unparseable, so `migrate` failed with
# "invalid port number" on every other fresh install.
sed -i \
  -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
  -e "s|^OPENEXAM_DOMAIN=.*|OPENEXAM_DOMAIN=$DOMAIN|" \
  -e "s|^NEXT_PUBLIC_BASE_URL=.*|NEXT_PUBLIC_BASE_URL=https://$DOMAIN|" \
  -e "s|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=https://$DOMAIN|" \
  -e "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://$DOMAIN|" \
  -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(gen)|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(alnum 40)|" \
  -e "s|^MATCHING_ID_SECRET=.*|MATCHING_ID_SECRET=$(gen)|" \
  -e "s|^TEACHER_ACCESS_CODE=.*|TEACHER_ACCESS_CODE=$(alnum 24)|" \
  -e "s|^AT_REST_ENC_KEY=.*|AT_REST_ENC_KEY=$(gen)|" \
  -e "s|^CAP_ADMIN_KEY=.*|CAP_ADMIN_KEY=$(alnum 32)|" \
  -e "s|^CAP_SECRET_KEY=.*|CAP_SECRET_KEY=sk-$(alnum 40)|" \
  -e "s|^NEXT_PUBLIC_CAP_WIDGET_ENDPOINT=.*|NEXT_PUBLIC_CAP_WIDGET_ENDPOINT=/cap-api/$(openssl rand -hex 5)/|" \
  -e "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=$(alnum 32)|" \
  -e "s|^GLITCHTIP_SECRET_KEY=.*|GLITCHTIP_SECRET_KEY=$(openssl rand -base64 48 | tr -d '\n')|" \
  -e "s|^GLITCHTIP_DB_PASSWORD=.*|GLITCHTIP_DB_PASSWORD=$(alnum 32)|" \
  -e "s|^MONITORING_DB_PASSWORD=.*|MONITORING_DB_PASSWORD=$(alnum 32)|" \
  -e "s|no-reply@exam.example.com|no-reply@$DOMAIN|" \
  .env.prod

echo "Wrote .env.prod (chmod 600) for $DOMAIN."
echo "Next steps: ./scripts/setup-prod.sh (or ./openexam install for the guided setup)."
