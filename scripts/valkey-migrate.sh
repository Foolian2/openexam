#!/usr/bin/env bash
# Move production from Redis 7 (volume redis_data) to Valkey (volume
# valkey_data). Full runbook: DEPLOYMENT.md's "Redis 7 → Valkey migration".
#
# Why this is not an image swap: Redis 7.4 writes RDB v12, which Valkey
# refuses by default ("Can't handle RDB format version 12") — #202 tried the
# swap and crash-looped the whole app tier. Valkey 8.1+ can be told to
# try anyway (`--rdb-version-check relaxed`); that only fails if the file
# holds an encoding Valkey doesn't know. So: copy the volume, load the COPY
# once in relaxed mode, rewrite the AOF so the files are Valkey's own format,
# and prove a strict (default) start reads them back.
#
#   --rehearse       No downtime. Copies the LIVE volume (mounted read-only)
#                    into a throwaway volume and runs the load + checks on
#                    that. Run this first; it must print PASS.
#   --yes-i-am-sure  The cutover. Stops the app tier, waits for ws-backend to
#                    drain buffered answers to Postgres, migrates into a new
#                    valkey_data volume and brings the stack up on Valkey.
#
# The cutover changes exactly one container: redis is recreated on Valkey +
# valkey_data, and every other service it stopped is restarted as the SAME
# container it was (`compose start`, not `up`). A plain `up -d` here would
# also recreate web/migrate/ws-backend from whatever :latest images happen to
# be on the host, slipping an unplanned app upgrade into the window. Roll the
# app forward afterwards with ./scripts/deploy.sh, as its own step.
#
# redis_data is never written to. Until redis is recreated at the very end,
# any failure restarts the existing (stopped, not removed) Redis 7
# containers, so the stack comes back exactly as it was. After the cutover, rolling back
# means pointing the redis service back at redis:7 + redis_data — writes made
# while on Valkey are lost.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/production-compose.sh
OLD_VOLUME=openexam-prod_redis_data
NEW_VOLUME=openexam-prod_valkey_data
REHEARSAL_VOLUME=openexam-valkey-rehearsal
WORKER=openexam-valkey-migrate
# Everything that talks to redis. nginx/web first so students stop producing
# answer saves; ws-backend keeps running until its buffer has drained.
FRONT=(nginx web glitchtip-web glitchtip-worker)
BACK=(ws-backend cap redis-exporter redis)
DRAIN_TIMEOUT=180

usage() {
  sed -n '13,19p' "$0" | sed 's/^# \{0,1\}//'
}

mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rehearse) mode=rehearse; shift ;;
    --yes-i-am-sure) mode=cutover; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done
[ -n "$mode" ] || { echo "ERROR: pass --rehearse or --yes-i-am-sure" >&2; usage; exit 1; }
[ -f .env.prod ] || { echo "ERROR: .env.prod missing"; exit 1; }

# Pinned image straight from the compose file, so the rehearsal tests exactly
# what the cutover will run.
VALKEY_IMAGE=$(grep -oE 'valkey/valkey:[^[:space:]"]+' docker-compose.prod.yml | head -n1)
[ -n "$VALKEY_IMAGE" ] || { echo "ERROR: no valkey/valkey image in docker-compose.prod.yml"; exit 1; }

site_key=$(grep '^NEXT_PUBLIC_CAP_WIDGET_ENDPOINT=' .env.prod | cut -d= -f2- | cut -d/ -f3)

redis_cid=$("${COMPOSE[@]}" ps -q redis || true)
[ -n "$redis_cid" ] || { echo "ERROR: redis service is not running."; exit 1; }
running_image=$(docker inspect -f '{{.Config.Image}}' "$redis_cid")
case "$running_image" in
  valkey/*) echo "redis is already running $running_image — nothing to migrate."; exit 0 ;;
esac
mounted=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$redis_cid")
[ "$mounted" = "$OLD_VOLUME" ] || { echo "ERROR: redis mounts '$mounted', expected $OLD_VOLUME."; exit 1; }

old_cli() { docker exec -i "$redis_cid" redis-cli "$@"; }
new_cli() { docker exec -i "$WORKER" valkey-cli "$@"; }

# "db0 cap 3" lines: per database, keys grouped by the part before the first
# colon (better-auth's raw session tokens have none → "(none)").
snapshot() {
  local cli=$1 db
  for db in $($cli INFO keyspace | tr -d '\r' | sed -nE 's/^db([0-9]+):.*/\1/p'); do
    $cli -n "$db" --scan --count 1000 \
      | awk -F: -v db="db$db" '{ p = (NF > 1 ? $1 : "(none)"); n[p]++ }
          END { for (p in n) print db, p, n[p] }'
  done | sort
}

total() { awk '{ s += $3 } END { print s + 0 }' "$1"; }
# Keys across all databases, from INFO keyspace ("db0:keys=12,expires=3,…").
keycount() { new_cli INFO keyspace | tr -d '\r' | sed -nE 's/^db[0-9]+:keys=([0-9]+).*/\1/p' | awk '{ s += $1 } END { print s + 0 }'; }

# Every container of the given services healthy (or running, if it has no
# healthcheck). Not `up --wait`: that also waits on the one-shot migrate jobs.
wait_healthy() {
  local i cid st bad
  for i in $(seq 1 150); do
    bad=0
    for cid in $("${COMPOSE[@]}" ps -q "$@"); do
      st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")
      case "$st" in healthy|running) ;; *) bad=1 ;; esac
    done
    [ "$bad" -eq 0 ] && return 0
    sleep 2
  done
  echo "ERROR: services not healthy after 300s:" >&2
  "${COMPOSE[@]}" ps "$@" >&2
  return 1
}

start_worker() {  # $@: extra valkey-server flags
  docker rm -f "$WORKER" >/dev/null 2>&1 || true
  docker run -d --name "$WORKER" --network none -v "$1:/data" "$VALKEY_IMAGE" \
    valkey-server --appendonly yes --appendfsync everysec "${@:2}" >/dev/null
  local i
  for i in $(seq 1 120); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" != true ]; then
      echo "ERROR: Valkey exited while loading:" >&2
      docker logs --tail 30 "$WORKER" >&2
      return 1
    fi
    # PING answers LOADING until the dataset is in memory.
    [ "$(new_cli ping 2>/dev/null | tr -d '\r')" = PONG ] && return 0
    sleep 1
  done
  echo "ERROR: Valkey did not finish loading within 120s." >&2
  docker logs --tail 30 "$WORKER" >&2
  return 1
}

stop_worker() { docker stop -t 30 "$WORKER" >/dev/null 2>&1 || true; docker rm -f "$WORKER" >/dev/null 2>&1 || true; }

# Every step ends in `|| return 1`: the rehearsal calls this inside `if`,
# where bash ignores set -e.
#
# Load $1 in relaxed mode, check it against snapshot file $2, rewrite it in
# Valkey's format, and prove a strict start reads it back.
migrate_volume() {
  local vol=$1 before=$2 after
  after=$(mktemp)

  echo "Copying $OLD_VOLUME → $vol..."
  docker run --rm --network none -v "$OLD_VOLUME:/from:ro" -v "$vol:/to" \
    --entrypoint sh "$VALKEY_IMAGE" -c 'cp -a /from/. /to/' || return 1

  echo "Loading the copy with $VALKEY_IMAGE (--rdb-version-check relaxed)..."
  start_worker "$vol" --rdb-version-check relaxed || return 1

  snapshot new_cli > "$after" || return 1
  echo
  echo "Keys per database/prefix (Redis 7 snapshot → Valkey):"
  join -a1 -a2 -e 0 -o 0,1.2,2.2 <(awk '{print $1"/"$2, $3}' "$before" | sort) \
                                 <(awk '{print $1"/"$2, $3}' "$after" | sort) \
    | awk '{ printf "  %-32s %8s → %s\n", $1, $2, $3 }'
  local b a
  b=$(total "$before"); a=$(total "$after")
  echo "  total: $b → $a"
  echo
  # Keys with a TTL can expire between snapshot and load, and in a rehearsal
  # the live store keeps changing — so differences are shown, not failed on.
  # What must hold: the data is there at all, and the Cap site key survived
  # (losing it means minting a new one and rebuilding the web image).
  if [ "$b" -gt 0 ] && [ "$a" -lt $(( b / 2 )) ]; then
    echo "FAIL: fewer than half the keys came across." >&2; return 1
  fi
  if [ -n "$site_key" ] && [ "$(new_cli EXISTS "cap:key:$site_key" | tr -d '\r')" != 1 ]; then
    echo "FAIL: cap:key:$site_key is missing after the load." >&2; return 1
  fi

  echo "Rewriting the AOF in Valkey's own format..."
  new_cli BGREWRITEAOF >/dev/null || return 1
  local i
  for i in $(seq 1 120); do
    new_cli INFO persistence | tr -d '\r' | grep -q '^aof_rewrite_in_progress:0' \
      && ! new_cli INFO persistence | tr -d '\r' | grep -q '^aof_rewrite_scheduled:1' && break
    sleep 1
  done
  new_cli INFO persistence | tr -d '\r' | grep -q '^aof_last_bgrewrite_status:ok' \
    || { echo "FAIL: AOF rewrite did not succeed." >&2; return 1; }
  local loaded reloaded; loaded=$(keycount)
  stop_worker

  echo "Restarting WITHOUT relaxed mode to prove the volume is Valkey-native..."
  start_worker "$vol" || return 1
  reloaded=$(keycount)
  # Only TTL expiry may account for a difference here.
  [ "$reloaded" -ge $(( loaded * 9 / 10 )) ] \
    || { echo "FAIL: strict reload has $reloaded keys, $loaded before." >&2; return 1; }
  echo "  strict reload: $reloaded keys"
  new_cli INFO server | tr -d '\r' | grep -E '^valkey_version:'
  stop_worker
  rm -f "$after"
}

# ── Rehearsal ──────────────────────────────────────────────────────────────
if [ "$mode" = rehearse ]; then
  before=$(mktemp)
  cleanup() { stop_worker; docker volume rm -f "$REHEARSAL_VOLUME" >/dev/null 2>&1 || true; rm -f "$before"; }
  trap cleanup EXIT
  docker volume rm -f "$REHEARSAL_VOLUME" >/dev/null 2>&1 || true
  docker volume create "$REHEARSAL_VOLUME" >/dev/null
  echo "Snapshotting live Redis ($(old_cli INFO server | tr -d '\r' | sed -n 's/^redis_version://p'))..."
  snapshot old_cli > "$before"
  if migrate_volume "$REHEARSAL_VOLUME" "$before"; then
    echo; echo "PASS — the cutover (--yes-i-am-sure) should work on this volume."
  else
    echo; echo "FAIL — do not run the cutover. Keep the output above; see DEPLOYMENT.md." >&2
    exit 1
  fi
  exit 0
fi

# ── Cutover ────────────────────────────────────────────────────────────────
if docker volume inspect "$NEW_VOLUME" >/dev/null 2>&1; then
  echo "ERROR: $NEW_VOLUME already exists. If it is from a failed run, inspect it and" >&2
  echo "       remove it by hand (docker volume rm $NEW_VOLUME) before retrying." >&2
  exit 1
fi

before=$(mktemp)
phase=running
restore() {
  local rc=$?
  stop_worker
  rm -f "$before"
  if [ "$phase" = up ]; then
    # The redis container is already recreated on valkey_data, which passed
    # every check — restarting the old one is no longer the right move.
    echo >&2
    echo "Valkey is in place but the stack did not come up healthy. Inspect with" >&2
    echo "  docker compose -f docker-compose.prod.yml ps / logs; DEPLOYMENT.md has the rollback." >&2
  elif [ "$phase" != done ] && [ "$phase" != running ]; then
    echo >&2
    echo "Cutover failed — restarting the existing Redis 7 stack on $OLD_VOLUME." >&2
    docker volume rm -f "$NEW_VOLUME" >/dev/null 2>&1 || true
    # `start` reuses the stopped containers as they were (redis:7 on
    # redis_data); it does not recreate them from the new compose file.
    "${COMPOSE[@]}" start "${BACK[@]}" "${FRONT[@]}" || true
    "${COMPOSE[@]}" exec -T nginx nginx -s reload || true
  fi
  exit "$rc"
}
trap restore EXIT

phase=front-stopped
echo "Stopping ${FRONT[*]}..."
"${COMPOSE[@]}" stop "${FRONT[@]}"

echo "Waiting for ws-backend to flush buffered answers (ws:dirtyexams → 0)..."
for i in $(seq 1 "$DRAIN_TIMEOUT"); do
  dirty=$(old_cli SCARD ws:dirtyexams | tr -dc '0-9')
  [ "${dirty:-1}" -eq 0 ] && break
  [ "$i" -eq "$DRAIN_TIMEOUT" ] && { echo "ERROR: $dirty exam(s) still dirty after ${DRAIN_TIMEOUT}s." >&2; exit 1; }
  sleep 1
done

snapshot old_cli > "$before"
echo "Stopping ${BACK[*]}..."
phase=back-stopped
"${COMPOSE[@]}" stop "${BACK[@]}"

# Labelled like a Compose-created volume, so `compose up` adopts it without
# the "volume already exists but was not created by Docker Compose" warning.
docker volume create \
  --label com.docker.compose.project=openexam-prod \
  --label com.docker.compose.volume=valkey_data \
  "$NEW_VOLUME" >/dev/null
migrate_volume "$NEW_VOLUME" "$before"

echo "Recreating redis on Valkey, then restarting the stopped services as they were..."
phase=up
"${COMPOSE[@]}" up -d --no-deps redis
wait_healthy redis
others=()
for svc in "${BACK[@]}"; do [ "$svc" = redis ] || others+=("$svc"); done
"${COMPOSE[@]}" start "${others[@]}" "${FRONT[@]}"
wait_healthy "${BACK[@]}" "${FRONT[@]}"
"${COMPOSE[@]}" exec -T nginx nginx -s reload
phase=done

echo
"${COMPOSE[@]}" exec -T redis valkey-cli INFO server | tr -d '\r' | grep -E '^valkey_version:'
echo "Done. Only redis changed; the app tier is still the previously deployed build."
echo "Next: ./scripts/deploy.sh to roll the app forward to this checkout."
echo "$OLD_VOLUME is untouched — keep it until the Valkey stack has run"
echo "through at least one real exam, then remove it (DEPLOYMENT.md)."
