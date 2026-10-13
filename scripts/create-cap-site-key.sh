#!/usr/bin/env bash
# Create the Cap CAPTCHA site key via cap's admin API and write the real
# values into .env.prod (NEXT_PUBLIC_CAP_WIDGET_ENDPOINT + CAP_SECRET_KEY).
# This replaces the old SSH-tunnel-to-the-dashboard workflow: the admin API
# lives at /server/* inside the Docker network and authenticates with a login
# session created from CAP_ADMIN_KEY — no port publishing, no browser.
#
# Requires the stack to be up (cap + redis running) and .env.prod to exist.
# Idempotent: if the site key already baked into .env.prod is registered in
# cap, this does nothing. After a change, REDEPLOY — the widget endpoint is
# baked into the web image at build time:
#   ./scripts/create-cap-site-key.sh && ./scripts/deploy.sh
#
# Development (`./openexam install local` with the real captcha): point it at
# the dev stack and .env instead — then restart `pnpm dev`, which reads the
# endpoint at startup:
#   OE_COMPOSE_FILE=docker-compose.yml OE_ENV_FILE=.env ./scripts/create-cap-site-key.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/env-file.sh
. scripts/lib/env-file.sh

ENV_FILE="${OE_ENV_FILE:-.env.prod}"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE missing (scripts/gen-env-prod.sh)"; exit 1; }
if [ -n "${OE_COMPOSE_FILE:-}" ]; then
  COMPOSE=(docker compose -f "$OE_COMPOSE_FILE" --env-file "$ENV_FILE")
else
  # shellcheck source=scripts/lib/production-compose.sh
  source scripts/lib/production-compose.sh
fi

endpoint=$(env_get NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "$ENV_FILE")
site_key=$(printf '%s' "$endpoint" | cut -d/ -f3)
[ -n "$site_key" ] || { echo "ERROR: no site key in NEXT_PUBLIC_CAP_WIDGET_ENDPOINT ($ENV_FILE)"; exit 1; }

cap_id=$("${COMPOSE[@]}" ps -q cap)
[ -n "$cap_id" ] || { echo "ERROR: cap service not running — run ./scripts/deploy.sh first"; exit 1; }

# Already registered? Nothing to do.
if "${COMPOSE[@]}" exec -T redis valkey-cli --scan --pattern "cap:key:*" 2>/dev/null \
  | grep -q "^cap:key:${site_key}$"; then
  echo "site key $site_key already registered in cap — nothing to do."
  exit 0
fi

admin_key=$(env_get CAP_ADMIN_KEY "$ENV_FILE")
out=$(mktemp); chmod 600 "$out"; trap 'rm -f "$out" "$err"' EXIT
err=$(mktemp); chmod 600 "$err"

# The cap container is bun-based (its entrypoint runs `bun run …`), so its own
# bun does the admin API calls — no extra tooling on the host or in other
# containers. The site key/secret are written to a 0600 temp file, never echoed.
if ! docker exec -e CAP_ADMIN_KEY="$admin_key" "$cap_id" bun -e '
  const login = await (await fetch("http://localhost:3000/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin_key: process.env.CAP_ADMIN_KEY }),
  })).json();
  if (!login.success) { console.error("cap login failed — wrong CAP_ADMIN_KEY?"); process.exit(1); }
  const auth = btoa(JSON.stringify({ token: login.session_token, hash: login.hashed_token }));
  const r = await fetch("http://localhost:3000/server/keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify({ name: "openexam" }),
  });
  const keys = await r.json();
  if (!keys.siteKey) { console.error("key creation failed:", JSON.stringify(keys)); process.exit(1); }
  console.log(`${keys.siteKey} ${keys.secretKey}`);
' > "$out" 2>"$err"; then
  cat "$err" >&2
  exit 1
fi

read -r new_site_key new_secret_key < "$out"
[ -n "$new_site_key" ] && [ -n "$new_secret_key" ] || { echo "ERROR: cap returned no key pair"; exit 1; }

env_set NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "/cap-api/$new_site_key/" "$ENV_FILE"
env_set CAP_SECRET_KEY "$new_secret_key" "$ENV_FILE"

echo "Created site key $new_site_key (replacing $site_key) and wrote CAP_SECRET_KEY to $ENV_FILE."
if [ "$ENV_FILE" = .env.prod ]; then
  echo "Redeploy to bake it into the web image: ./scripts/deploy.sh"
fi
