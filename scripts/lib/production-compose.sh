# Source after changing directory to the repository root. Never source
# .env.prod as shell code: only read the backend selector here.
#
# Selecting the overlay needs nothing but this file, so every script (rollback,
# issue-cert, ...) keeps working whatever state the backup secrets are in.
# Scripts that enable archiving or touch the archive additionally call
# require_walg_secrets.
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
walg_backend=$(sed -n 's/^WALG_STORAGE_BACKEND=//p' .env.prod 2>/dev/null | tail -n 1 | tr -d '\r')
case "$walg_backend" in
  ''|disabled) walg_backend=disabled ;;
  sftp) COMPOSE+=(-f docker-compose.sftp.yml) ;;
  *) echo 'ERROR: WALG_STORAGE_BACKEND must be disabled or sftp' >&2; return 1 ;;
esac
# For instructions printed to the operator: the same files this script uses.
COMPOSE_CMD=$(printf '%q ' "${COMPOSE[@]}")
COMPOSE_CMD=${COMPOSE_CMD% }

# Same pinned base as infra/walg-sftp/Dockerfile.
WALG_HELPER_IMAGE=alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0

# Validate the SFTP secrets. They are owned by uid 999 with mode 0600 (the
# Postgres and tunnel containers' uid), so the deploy user usually cannot read
# them; the check runs in a throwaway container with no network that may only
# bypass read permissions. Needs Docker only, not Node.
require_walg_secrets() {
  [ "$walg_backend" = sftp ] || return 0
  [ -d secrets ] || { echo 'ERROR: secrets/ is missing; see DEPLOYMENT.md "Encrypted SFTP backups"' >&2; return 1; }
  docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --mount "type=bind,src=$PWD/secrets,dst=/secrets,readonly" \
    "$WALG_HELPER_IMAGE" sh -c '
      set -eu
      cd /secrets
      for name in walg_ssh_key walg_libsodium_key walg_known_hosts; do
        [ -f "$name" ] || { echo "ERROR: secrets/$name is missing" >&2; exit 1; }
        if [ "$(stat -c "%u %a" "$name")" != "999 600" ]; then
          echo "ERROR: secrets/$name must be mode 0600 and owned by uid 999 (container postgres)" >&2; exit 1
        fi
      done
      key=$(tr -d " \t\r\n" < walg_libsodium_key)
      printf "%s" "$key" | grep -Eqx "[a-f0-9]{64}" || { echo "ERROR: invalid backup encryption key" >&2; exit 1; }
      saved=$(tr -d " \t\r\n" 2>/dev/null < .walg_key_saved || true)
      if [ "$saved" != "$(printf "%s" "$key" | sha256sum | cut -d" " -f1)" ]; then
        echo "ERROR: acknowledge the recovery sheet for this key before enabling SFTP:" >&2
        echo "  new key:       scripts/setup-walg-sftp.sh HOST USER /REMOTE/DIRECTORY" >&2
        echo "  from a sheet:  scripts/restore-walg-key.sh" >&2
        exit 1
      fi
      grep -q "[^[:space:]]" walg_known_hosts || { echo "ERROR: pinned backup host key is missing" >&2; exit 1; }
    '
}
