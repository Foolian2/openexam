#!/usr/bin/env bash
# Generate the SFTP backup keys and the encryption-key recovery PDF
# (DEPLOYMENT.md "Encrypted SFTP backups"). Runs scripts/setup-walg-sftp.mjs
# inside the Dockerfile's walg-setup stage, so the host needs Docker only.
# Never deploys or changes archive_command.
#
#   scripts/setup-walg-sftp.sh HOST USER /REMOTE/DIRECTORY
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 3 ]; then
  echo "Usage: scripts/setup-walg-sftp.sh HOST USER /REMOTE/DIRECTORY" >&2
  exit 1
fi

umask 077
mkdir -p secrets
chmod 700 secrets

# .dockerignore keeps secrets/ out of this build context.
docker build -q --target walg-setup -t openexam-walg-setup:latest . >/dev/null

# Root in a network-less container so it can hand the private keys to uid 999
# (the Postgres and tunnel containers) and the PDF to the invoking user.
tty_flags=(-i)
[ -t 0 ] && tty_flags+=(-t)
docker run --rm "${tty_flags[@]}" --network none \
  --mount "type=bind,src=$PWD/secrets,dst=/app/secrets" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e HOST_SECRETS_DIR="$PWD/secrets" \
  openexam-walg-setup:latest "$@"
