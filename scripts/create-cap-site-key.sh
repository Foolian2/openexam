#!/usr/bin/env bash
# Create the Cap CAPTCHA site key via cap's admin API and write the real
# values into .env.prod (NEXT_PUBLIC_CAP_WIDGET_ENDPOINT + CAP_SECRET_KEY).
# This replaces the old SSH-tunnel-to-the-dashboard workflow: the admin API
# lives at /server/* inside the Docker network and authenticates with a login
# session created from CAP_ADMIN_KEY — no port publishing, no browser.
#
# Requires the stack to be up (cap + redis running) and .env.prod to exist.
# Idempotent: if the site key already baked into .env.prod is registered in
# cap, no key is created. Either way the key gets a class-sized rate limit if
# it has none yet (see CAP_RATELIMIT_* below); a limit already set, e.g. in
# cap's dashboard, is left alone. After a NEW key, REDEPLOY — the widget
# endpoint is baked into the web image at build time:
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

# Cap rate-limits per client IP, and a school sends a whole class through one
# NAT address. Its default (30 requests per 5 s) refuses a class signing in
# together; one sign-in costs the widget 2-3 cap requests (a prefetched
# challenge, the challenge, the redeem), so this admits about 200 students per
# minute — the same cohort lib/auth.ts's per-IP sign-in rule is sized for.
# The proof-of-work, not this limit, is what makes each attempt expensive.
CAP_RATELIMIT_MAX=600
CAP_RATELIMIT_MS=60000

# Already registered? Then only its rate limit may need setting.
create=1
if "${COMPOSE[@]}" exec -T redis valkey-cli --scan --pattern "cap:key:*" 2>/dev/null \
  | grep -q "^cap:key:${site_key}$"; then
  create=0
fi

# Exported and passed to docker by NAME, so the value never appears on a
# command line (/proc/<pid>/cmdline) — the convention the rest of the CLI keeps.
CAP_ADMIN_KEY=$(env_get CAP_ADMIN_KEY "$ENV_FILE")
export CAP_ADMIN_KEY
out=$(mktemp); chmod 600 "$out"; trap 'rm -f "$out" "$err"' EXIT
err=$(mktemp); chmod 600 "$err"

# The cap container is bun-based (its entrypoint runs `bun run …`), so its own
# bun does the admin API calls — no extra tooling on the host or in other
# containers. The site key/secret are written to a 0600 temp file, never echoed.
if ! docker exec -e CAP_ADMIN_KEY -e CAP_CREATE="$create" -e CAP_SITE_KEY="$site_key" \
  -e CAP_RATELIMIT_MAX="$CAP_RATELIMIT_MAX" -e CAP_RATELIMIT_MS="$CAP_RATELIMIT_MS" \
  "$cap_id" bun -e '
  const base = "http://localhost:3000";
  const login = await (await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin_key: process.env.CAP_ADMIN_KEY }),
  })).json();
  if (!login.success) { console.error("cap login failed — wrong CAP_ADMIN_KEY?"); process.exit(1); }
  const auth = btoa(JSON.stringify({ token: login.session_token, hash: login.hashed_token }));
  const headers = { "content-type": "application/json", authorization: `Bearer ${auth}` };

  let siteKey = process.env.CAP_SITE_KEY;
  let secretKey = "-";
  if (process.env.CAP_CREATE === "1") {
    const r = await fetch(`${base}/server/keys`, {
      method: "POST",
      headers,
      // Cap >= 3.1.12 defaults new keys to "hashwx", which needs
      // @cap.js/widget >= 0.1.58; the widget pinned in
      // components/auth/cap-widget.tsx is older, so ask for the protocol it
      // solves (the one every key created before 3.1.12 already uses).
      body: JSON.stringify({ name: "openexam", protocol: "sha256-pow" }),
    });
    const keys = await r.json();
    if (!keys.siteKey) { console.error("key creation failed:", JSON.stringify(keys)); process.exit(1); }
    siteKey = keys.siteKey;
    secretKey = keys.secretKey;
  }

  const current = await (await fetch(`${base}/server/keys/${siteKey}`, { headers })).json();
  if (!current.key) { console.error("reading key failed:", JSON.stringify(current)); process.exit(1); }
  const config = current.key.config;
  let limit = "kept";
  if (config.ratelimitMax == null || config.ratelimitDuration == null) {
    const r = await fetch(`${base}/server/keys/${siteKey}/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ratelimitMax: Number(process.env.CAP_RATELIMIT_MAX),
        ratelimitDuration: Number(process.env.CAP_RATELIMIT_MS),
      }),
    });
    const res = await r.json();
    if (!res.success) { console.error("setting the rate limit failed:", JSON.stringify(res)); process.exit(1); }
    config.ratelimitMax = Number(process.env.CAP_RATELIMIT_MAX);
    config.ratelimitDuration = Number(process.env.CAP_RATELIMIT_MS);
    limit = "set";
  }
  console.log(`${siteKey} ${secretKey} ${limit} ${config.ratelimitMax} ${config.ratelimitDuration}`);
' > "$out" 2>"$err"; then
  cat "$err" >&2
  exit 1
fi

read -r new_site_key new_secret_key limit_state limit_max limit_ms < "$out"
limit_note="rate limit ${limit_max} requests per $((limit_ms / 1000)) s per IP"
if [ "$limit_state" = set ]; then
  limit_note="set its $limit_note"
else
  limit_note="kept its existing $limit_note"
fi

if [ "$create" = 0 ]; then
  echo "site key $site_key already registered in cap; $limit_note."
  exit 0
fi

[ -n "$new_site_key" ] && [ "$new_secret_key" != "-" ] || { echo "ERROR: cap returned no key pair"; exit 1; }

env_set NEXT_PUBLIC_CAP_WIDGET_ENDPOINT "/cap-api/$new_site_key/" "$ENV_FILE"
env_set CAP_SECRET_KEY "$new_secret_key" "$ENV_FILE"

echo "Created site key $new_site_key (replacing $site_key), $limit_note, and wrote CAP_SECRET_KEY to $ENV_FILE."
if [ "$ENV_FILE" = .env.prod ]; then
  echo "Redeploy to bake it into the web image: ./scripts/deploy.sh"
fi
