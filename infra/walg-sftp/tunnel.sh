#!/bin/sh
set -eu
: "${WALG_SSH_HOST:?Set WALG_SSH_HOST}"
: "${WALG_SSH_USER:?Set WALG_SSH_USER}"
: "${WALG_SSH_PORT:=22}"
# wal-g's native SFTP driver ignores host keys. Carry that connection
# inside this host-verified SSH transport; listen only on a private Docker
# network with no published host port. The forward targets the backup
# host's own sshd on the same port this connection uses, so the account's
# permitopen/PermitOpen must name 127.0.0.1:$WALG_SSH_PORT.
exec ssh -NT \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/run/secrets/walg_known_hosts \
  -o GlobalKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
  -i /run/secrets/walg_ssh_key -p "$WALG_SSH_PORT" \
  -L "0.0.0.0:2222:127.0.0.1:$WALG_SSH_PORT" \
  "$WALG_SSH_USER@$WALG_SSH_HOST"
