#!/usr/bin/env bash
# Disaster recovery: re-create secrets/walg_libsodium_key from the printed
# recovery sheet on a rebuilt host. Typing the key from the sheet is itself
# the acknowledgement that an off-host copy exists, so this also records
# secrets/.walg_key_saved — without it every SFTP deploy and restore stops.
# Next: scripts/setup-walg-sftp.sh for a new SSH credential (it skips the PDF
# for an acknowledged key), then DEPLOYMENT.md "Encrypted SFTP backups".
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/production-compose.sh

umask 077
mkdir -p secrets
chmod 700 secrets

printf 'Encryption key from the recovery sheet (input hidden; spaces ignored): '
IFS= read -rs key
echo
key=$(printf '%s' "$key" | tr -d '[:space:]' | tr 'A-F' 'a-f')
if ! printf '%s' "$key" | grep -Eqx '[a-f0-9]{64}'; then
  echo "ERROR: expected 64 hexadecimal characters; nothing was written." >&2
  exit 1
fi

# Written as root in a network-less container: the key must belong to uid
# 999 (the Postgres container), which the deploy user cannot chown to.
printf '%s' "$key" | docker run --rm -i --network none \
  --mount "type=bind,src=$PWD/secrets,dst=/secrets" \
  "$WALG_HELPER_IMAGE" sh -c '
    set -eu
    cd /secrets
    key=$(cat)
    if [ -e walg_libsodium_key ] && [ "$(tr -d " \t\r\n" < walg_libsodium_key)" != "$key" ]; then
      echo "ERROR: secrets/walg_libsodium_key already holds a different key; move it aside first." >&2
      exit 1
    fi
    printf "%s" "$key" > walg_libsodium_key.tmp
    chown 999:999 walg_libsodium_key.tmp
    chmod 600 walg_libsodium_key.tmp
    mv walg_libsodium_key.tmp walg_libsodium_key
    printf "%s\n" "$(printf "%s" "$key" | sha256sum | cut -d" " -f1)" > .walg_key_saved
    chmod 600 .walg_key_saved
  '
echo "OK: secrets/walg_libsodium_key restored and the recovery sheet acknowledged."
echo "Next: scripts/setup-walg-sftp.sh HOST USER /REMOTE/DIRECTORY for a new SSH key."
