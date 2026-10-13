#!/usr/bin/env bash
# Roll the web and ws-backend tiers back to a previously deployed image.
#
#   ./scripts/rollback.sh              # back to the previous deploy
#   ./scripts/rollback.sh a1b2c3d      # back to a specific tag
#   ./scripts/rollback.sh a1b2c3d --force
#
# This re-points running containers at an image that is already on the host.
# It does not build, so it takes seconds — which is the entire point. The
# alternative, and what this repo had before: `git checkout <sha> && deploy.sh`,
# a full rebuild while the site is down, and only if that older commit still
# builds against today's registries and lockfiles.
#
# What it does NOT do:
#   - roll the database back. Nothing here touches data, and rolling code back
#     under a migrated schema is the risk the guard below exists for.
#   - roll postgres back. See that service's comment in docker-compose.prod.yml.
#   - rewrite .deploy-history. A later ./scripts/deploy.sh rolls forward again.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/production-compose.sh
DEPLOY_HISTORY=.deploy-history
# postgres is deliberately absent — see the header.
ROLLED_IMAGES=(openexam-web openexam-migrate openexam-ws-backend)

force=false
target=""
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    -*) echo "ERROR: unknown flag $arg" >&2; exit 1 ;;
    *) target="$arg" ;;
  esac
done

[ -f .env.prod ] || { echo "ERROR: .env.prod missing (copy .env.example)" >&2; exit 1; }

# ---------------------------------------------------------------- target tag

if [ -z "$target" ]; then
  [ -f "$DEPLOY_HISTORY" ] || {
    echo "ERROR: no $DEPLOY_HISTORY — nothing has been deployed by scripts/deploy.sh yet." >&2
    echo "       Pass a tag explicitly: ./scripts/rollback.sh <tag>" >&2
    exit 1
  }
  # The last line is the deploy currently running. Search backward for the
  # most recent entry with a *different* tag — a redeploy of the same commit
  # (e.g. after an env-var change) appends a duplicate of the current tag,
  # and that duplicate is not a previous deploy to roll back to.
  target=$(awk '{ tags[NR] = $1 }
    END {
      current = tags[NR]
      for (i = NR - 1; i >= 1; i--) {
        if (tags[i] != current) { print tags[i]; exit }
      }
    }' "$DEPLOY_HISTORY")
  if [ -z "$target" ]; then
    echo "ERROR: $DEPLOY_HISTORY has no deploy distinct from the current one — there is no previous deploy." >&2
    exit 1
  fi
fi

for image in "${ROLLED_IMAGES[@]}"; do
  if ! docker image inspect "${image}:${target}" >/dev/null 2>&1; then
    echo "ERROR: ${image}:${target} is not on this host." >&2
    echo "       deploy.sh keeps only the last few builds. Available:" >&2
    docker images --format '  {{.Repository}}:{{.Tag}}' "$image" >&2
    exit 1
  fi
done

# --------------------------------------------------------- migration guard

# Prisma migrations are forward-only. If the database has applied a migration
# that the target commit does not contain, the older code is about to run
# against a newer schema — which is fine for a purely additive (expand/contract)
# migration and corrupting for anything else. Only a human knows which this is,
# so refuse by default and make --force the deliberate act.
if ! git rev-parse --verify --quiet "${target}^{commit}" >/dev/null; then
  echo "WARNING: commit ${target} is not in this repository, so the migration" >&2
  echo "         guard cannot run. Verify the schema by hand before continuing." >&2
  $force || { echo "Refusing without --force." >&2; exit 1; }
else
  applied=$("${COMPOSE[@]}" exec -T postgres \
    psql -U openexam -d openexam -tAc \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name" \
    | tr -d '\r' | sed '/^$/d')

  target_migrations=$(git ls-tree -r --name-only "$target" -- prisma/migrations \
    | awk -F/ 'NF >= 4 { print $3 }' | sort -u)

  # Applied in the database, absent from the target commit.
  ahead=$(comm -23 <(echo "$applied" | sort) <(echo "$target_migrations" | sort) | sed '/^$/d')

  if [ -n "$ahead" ]; then
    echo "The database is ahead of ${target}. Migrations applied here that ${target} does not know about:" >&2
    echo "$ahead" | sed 's/^/  /' >&2
    echo >&2
    if $force; then
      echo "--force given: continuing. The rolled-back code will run against the newer schema." >&2
    else
      echo "Refusing. Roll back only if every migration above is additive (a nullable" >&2
      echo "column, a new table) so the older code simply ignores it — then re-run with" >&2
      echo "--force. If any of them dropped or renamed something the old code reads," >&2
      echo "restore from backup instead (DEPLOYMENT.md, 'Point-in-time recovery')." >&2
      exit 1
    fi
  fi
fi

# ------------------------------------------------------------------ roll it

echo "Rolling back to ${target}."
IMAGE_TAG="$target" "${COMPOSE[@]}" up -d --no-build web ws-backend

# web depends_on migrate completing successfully, so Compose starts it with the
# old image too. `prisma migrate deploy` there is a no-op against an
# already-current schema; it never un-applies anything.

# Same staleness deploy.sh handles: nginx resolves its upstreams once at start
# and the web replicas just got new IPs.
"${COMPOSE[@]}" exec nginx nginx -s reload

echo
echo "Rolled back to ${target}. Status:"
"${COMPOSE[@]}" ps
echo
echo "$DEPLOY_HISTORY is unchanged — ./scripts/deploy.sh rolls forward again."
