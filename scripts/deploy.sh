#!/usr/bin/env bash
# One-command production deploy (PRD §15.3): build images, run migrations,
# roll the stack, then reload nginx so it re-resolves the web replica IPs
# (its upstream DNS is resolved once at startup and goes stale after
# containers are replaced).
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/production-compose.sh
# The monitoring services are behind a compose profile (opt-in). Once
# scripts/setup-monitoring.sh has rendered alertmanager's config, deploys
# include them so their images and definitions stay current like the rest.
if [ -f monitoring/alertmanager/alertmanager.yml ]; then
  COMPOSE+=(--profile monitoring)
fi

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (copy .env.example)"; exit 1; }
require_walg_secrets
[ -e certs/live/openexam/fullchain.pem ] || {
  echo "ERROR: no TLS cert at certs/live/openexam/ — see DEPLOYMENT.md (bootstrap)"; exit 1
}

# The web tier refuses to boot without valid values for these (lib/env.ts:
# /datenschutz and /impressum must name the school). Checked here, before
# anything is built or rolled, so a bad value stops the deploy instead of
# crash-looping the replicas that are currently serving. The rules mirror
# lib/env.ts: PLACEHOLDER_RE for the required keys, and zod's email regex
# (z.string().email()) for the two address fields.
legal_placeholder_re='^(sk[-_]?)?(change[-_]?me|changeme|your[-_][a-z0-9-]+|example|placeholder|todo|dummy)$'
legal_email_re="^([A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$"
legal_value() {
  grep -E "^$1=" .env.prod | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true
}
bad_legal=()
for key in LEGAL_CONTROLLER_NAME LEGAL_CONTROLLER_ADDRESS LEGAL_CONTACT_EMAIL LEGAL_HOSTING_PROVIDER; do
  value=$(legal_value "$key")
  if [ -z "$value" ]; then
    bad_legal+=("$key (missing)")
  elif printf '%s' "$value" | grep -qiE "$legal_placeholder_re"; then
    bad_legal+=("$key (still a placeholder)")
  fi
done
for key in LEGAL_CONTACT_EMAIL LEGAL_DPO_EMAIL; do
  value=$(legal_value "$key")
  if [ -n "$value" ] && ! printf '%s' "$value" | grep -qE "$legal_email_re"; then
    bad_legal+=("$key (not an email address)")
  fi
done
if [ "${#bad_legal[@]}" -gt 0 ]; then
  echo "ERROR: fix these in .env.prod first (shown on /datenschutz and /impressum):"
  printf '         %s\n' "${bad_legal[@]}"
  echo "       See the 'Datenschutzerklärung & Impressum' section of .env.example, then re-run."
  exit 1
fi

# The redis service now mounts valkey_data, not redis_data (see its comment in
# docker-compose.prod.yml). Deploying before scripts/valkey-migrate.sh has run
# would start Valkey on a fresh, empty volume — dropping the Cap site key
# registration and anything else still in Redis 7 — so refuse instead.
if docker volume inspect openexam-prod_redis_data >/dev/null 2>&1 \
  && ! docker volume inspect openexam-prod_valkey_data >/dev/null 2>&1; then
  echo "ERROR: redis_data exists but valkey_data does not — the Valkey migration hasn't run."
  echo "       Run ./scripts/valkey-migrate.sh --rehearse, then --yes-i-am-sure (DEPLOYMENT.md)."
  exit 1
fi

# Tag this build with the commit it came from. Compose reads IMAGE_TAG from the
# process environment (which wins over --env-file), so `build` produces
# openexam-web:<sha> instead of overwriting whatever is currently deployed —
# that surviving previous image is the whole basis of scripts/rollback.sh.
#
# Locally built images only. The pulled ones stay digest-pinned in the compose
# file and are unaffected by this. openexam-postgres is also built locally
# but is deliberately excluded here — its image tag in docker-compose.prod.yml
# is fixed at :latest, not ${IMAGE_TAG}, so it never gets recreated by an
# ordinary app deploy (see that service's comment). `compose build` tags it
# straight to :latest itself; there is no per-commit tag to move or prune.
BUILT_IMAGES=(openexam-web openexam-migrate openexam-ws-backend)
KEEP_TAGS=5
DEPLOY_HISTORY=.deploy-history

IMAGE_TAG=$(git rev-parse --short HEAD)
export IMAGE_TAG
if [ -n "$(git status --porcelain)" ]; then
  # The tag would name a commit that does not describe what was built, and
  # rollback.sh's migration guard resolves migrations from exactly that commit.
  echo "ERROR: working tree is dirty — commit or stash before deploying."
  echo "       (IMAGE_TAG comes from the commit SHA; a dirty tree makes it a lie.)"
  exit 1
fi
echo "Deploying ${IMAGE_TAG}."

"${COMPOSE[@]}" build

# Move :latest to what was just built, so a bare `docker compose up` (without
# IMAGE_TAG in the environment) keeps resolving to the current deploy rather
# than to whatever happened to be tagged latest first.
for image in "${BUILT_IMAGES[@]}"; do
  docker tag "${image}:${IMAGE_TAG}" "${image}:latest"
done

"${COMPOSE[@]}" up -d --remove-orphans

# Belt-and-suspenders: web already depends on migrate completing successfully,
# but surface a failed migration loudly instead of a vague dependency error.
# (`docker compose wait` errors on already-exited containers, so read the
# recorded exit code instead.)
if [ "$("${COMPOSE[@]}" ps -a migrate --format '{{.ExitCode}}')" != "0" ]; then
  echo "ERROR: migration failed:"
  "${COMPOSE[@]}" logs migrate
  exit 1
fi

"${COMPOSE[@]}" exec nginx nginx -s reload
source scripts/lib/pitr-state.sh

# Prometheus does not pick up its own config on a `git pull && deploy.sh`.
# Two separate reasons, and only a recreate covers both:
#
#   - prometheus.yml is bind-mounted as a single FILE, and Docker binds a file
#     by inode. `git pull` replaces the file rather than writing in place, so
#     the running container keeps serving the old inode — a /-/reload would
#     faithfully re-read the stale config. (See DEPLOYMENT.md, "Recreating
#     single containers by hand".)
#   - Compose will not recreate the service on its own: its image, service
#     definition and mount paths are all unchanged by an app deploy.
#
# The consequence, before this existed: a scrape job or alert rule added in a
# commit stayed inert on every host until someone recreated Prometheus by hand,
# while `promtool` and the rules UI both reported everything healthy.
#
# Guarded on the container actually running, because the monitoring stack is
# opt-in (scripts/setup-monitoring.sh) and most of this file must keep working
# without it. Config is validated BEFORE the recreate so a typo fails loudly
# here instead of leaving Prometheus down after an otherwise-good deploy.
if [ -n "$("${COMPOSE[@]}" ps -q prometheus 2>/dev/null)" ]; then
  echo "Validating Prometheus config..."
  if "${COMPOSE[@]}" exec -T prometheus promtool check config /etc/prometheus/prometheus.yml; then
    echo "Recreating Prometheus to pick up config and rule changes..."
    "${COMPOSE[@]}" up -d --force-recreate --no-deps prometheus
  else
    # Not fatal: the app deploy above already succeeded, and failing here would
    # wrongly imply it did not. Loud enough not to be missed.
    echo "WARNING: Prometheus config failed validation — NOT recreating." >&2
    echo "         Monitoring is running the previous config; fix and re-run." >&2
  fi
fi

# Recorded after the deploy succeeds, never before: rollback.sh reads this file
# to find "the previous deploy", and a tag that failed on the way up is not one.
# Appending (rather than tracking only the last) keeps more than one step back
# available when a regression is noticed late.
printf '%s %s\n' "$IMAGE_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$DEPLOY_HISTORY"

# Keep the last few builds and drop the rest. Untagging is all that happens
# here — Docker reclaims the layers on its own once nothing references them,
# and :latest plus any running container keep the current images alive
# regardless of where they fall in this list.
#
# Which tags to keep comes from DEPLOY_HISTORY, not `docker images` output
# order: when a component is unchanged between deploys, the build cache
# reuses the same image ID and just adds a new tag, so several recent tags
# share old creation metadata and `docker images`' age-based ordering does
# not reflect deployment order — pruning by it can drop a tag that
# DEPLOY_HISTORY still advertises as available.
keep_tags=$(awk -v keep="$KEEP_TAGS" '{ tags[NR] = $1 }
  END {
    n = 0
    for (i = NR; i >= 1 && n < keep; i--) {
      if (!(tags[i] in seen)) { seen[tags[i]] = 1; print tags[i]; n++ }
    }
  }' "$DEPLOY_HISTORY")

for image in "${BUILT_IMAGES[@]}"; do
  docker images --format '{{.Tag}}' "$image" \
    | grep -v '^latest$' \
    | while read -r old_tag; do
        if ! grep -qxF "$old_tag" <<< "$keep_tags"; then
          docker rmi "${image}:${old_tag}" >/dev/null 2>&1 || true
        fi
      done
done

echo "Deployed ${IMAGE_TAG}. Status:"
"${COMPOSE[@]}" ps

# Warn (not fail) when the Cap site key baked into the web image isn't
# registered in cap yet: the captcha gates (sign-up, sign-in, access-code
# join) answer 404 until scripts/create-cap-site-key.sh runs and the image is
# rebuilt. A mismatch shows up as a silent captcha failure, so surface it here
# at every deploy instead of leaving it to the first puzzled user.
site_key=$(grep '^NEXT_PUBLIC_CAP_WIDGET_ENDPOINT=' .env.prod 2>/dev/null | cut -d= -f2- | cut -d/ -f3)
if [ -n "$site_key" ]; then
  registered=$("${COMPOSE[@]}" exec -T redis valkey-cli --scan --pattern "cap:key:*" 2>/dev/null \
    | grep -c "^cap:key:${site_key}$" || true)
  if [ "$registered" -eq 0 ]; then
    echo
    echo "NOTE: Cap site key ${site_key} is not registered in cap yet — captcha gates will 404."
    echo "      Run ./scripts/create-cap-site-key.sh and deploy again."
  fi
fi
