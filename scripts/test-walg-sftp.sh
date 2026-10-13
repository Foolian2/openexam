#!/usr/bin/env bash
# Real SFTP integration on disposable containers. No production volumes.
set -euo pipefail
cd "$(dirname "$0")/.."
trial="openexam-sftp-test-$(date +%s)-$$"
fixture=$(mktemp -d)
cleanup() {
  docker rm -f "$trial-tunnel" "$trial-server" "$trial-rejected" >/dev/null 2>&1 || true
  docker network rm "$trial" >/dev/null 2>&1 || true
  docker image rm "$trial-server:latest" "$trial-tunnel:latest" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
cp infra/walg-sftp/test-server/* "$fixture/"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/key"
printf 'restrict,port-forwarding,permitopen="127.0.0.1:22" ' > "$fixture/authorized_keys"
cat "$fixture/key.pub" >> "$fixture/authorized_keys"
openssl rand -hex 32 | tr -d '\n' > "$fixture/encryption"
docker build -q -t "$trial-server" "$fixture" >/dev/null
docker build -q -t "$trial-tunnel" infra/walg-sftp >/dev/null
docker network create "$trial" >/dev/null
docker run -d --name "$trial-server" --network "$trial" --network-alias backup-test "$trial-server" >/dev/null
docker exec "$trial-server" cat /etc/ssh/ssh_host_ed25519_key.pub | sed 's/^/backup-test /' > "$fixture/known_hosts"
# Bind-mounted secrets need to be readable by the non-root tunnel uid.
chown 999:999 "$fixture/key" "$fixture/known_hosts"
chmod 600 "$fixture/key" "$fixture/known_hosts"
docker run -d --name "$trial-tunnel" --network "$trial" --network-alias walg-sftp \
  -e WALG_SSH_HOST=backup-test -e WALG_SSH_USER=walg \
  -v "$fixture/key:/run/secrets/walg_ssh_key:ro" \
  -v "$fixture/known_hosts:/run/secrets/walg_known_hosts:ro" "$trial-tunnel" >/dev/null
# The production healthcheck: an SSH banner must arrive through the forward.
for i in $(seq 1 30); do
  docker exec "$trial-tunnel" tunnel-healthcheck && break
  [ "$i" -ne 30 ] || { docker logs "$trial-tunnel"; exit 1; }
  sleep 1
done
docker run --rm --network "$trial" --entrypoint sh \
  -v "$fixture/key:/key:ro" -v "$fixture/encryption:/encryption:ro" \
  -e WALG_SSH_PREFIX=ssh://walg-sftp/archive -e SSH_PORT=2222 \
  -e SSH_USERNAME=walg -e SSH_PRIVATE_KEY_PATH=/key \
  -e WALG_LIBSODIUM_KEY_PATH=/encryption -e WALG_LIBSODIUM_KEY_TRANSFORM=hex \
  "${TEST_WALG_IMAGE:-openexam-postgres:latest}" -c '
    set -e
    printf "encrypted SFTP integration probe" > /tmp/probe
    wal-g st put --no-compress /tmp/probe probe
    wal-g st get --no-decompress probe /tmp/restored
    cmp /tmp/probe /tmp/restored
    printf "%064d" 0 > /tmp/wrongkey
    if WALG_LIBSODIUM_KEY_PATH=/tmp/wrongkey wal-g st get --no-decompress probe /tmp/rejected >/dev/null 2>&1; then
      echo "Wrong key unexpectedly decrypted the archive" >&2; exit 1
    fi
  '
# Inspect every uploaded file, wherever wal-g put it. grep exits 1 only when
# it read the files and found no match; 2 (nothing to read) must fail too.
uploaded=$(docker exec "$trial-server" find /srv/backups/archive -type f)
[ -n "$uploaded" ] || { echo 'Nothing was uploaded to the remote archive' >&2; exit 1; }
status=0
docker exec "$trial-server" grep -rqF 'encrypted SFTP integration probe' /srv/backups/archive || status=$?
case "$status" in
  0) echo 'Remote archive contains plaintext' >&2; exit 1 ;;
  1) ;;
  *) echo "Could not inspect the remote archive (grep exit $status)" >&2; exit 1 ;;
esac
# Another valid host key must fail before any account authentication.
ssh-keygen -q -t ed25519 -N '' -f "$fixture/wrong-host"
sed 's/^/backup-test /' "$fixture/wrong-host.pub" > "$fixture/wrong-known-hosts"
chown 999:999 "$fixture/wrong-known-hosts"
chmod 600 "$fixture/wrong-known-hosts"
if docker run --name "$trial-rejected" --network "$trial" \
  -e WALG_SSH_HOST=backup-test -e WALG_SSH_USER=walg \
  -v "$fixture/key:/run/secrets/walg_ssh_key:ro" \
  -v "$fixture/wrong-known-hosts:/run/secrets/walg_known_hosts:ro" "$trial-tunnel" > "$fixture/rejected.log" 2>&1; then
  echo 'Wrong host key unexpectedly accepted' >&2; exit 1
fi
grep -q 'Host key verification failed' "$fixture/rejected.log"
echo 'PASS: encrypted SFTP round-trip, wrong-key rejection, and host-key pinning.'
