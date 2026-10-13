#!/usr/bin/env bash
# Install Docker Engine + the Compose v2 plugin from Docker's official apt
# repository (https://docs.docker.com/engine/install/ubuntu/), the way
# DEPLOYMENT.md's target host (Ubuntu 24.04) expects. Ubuntu and Debian only;
# anything else gets a pointer to the docs. Run as root.
#
#   sudo ./scripts/install-docker.sh [--yes]
#
# Also adds $SUDO_USER (the account that ran sudo) to the docker group, so
# deploy scripts can run without sudo after the next login. Idempotent:
# exits early when `docker compose` already works.
set -euo pipefail

assume_yes=0
[ "${1:-}" = --yes ] && assume_yes=1

if docker compose version >/dev/null 2>&1; then
  echo "Docker and Compose v2 are already installed: $(docker --version)"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (sudo $0)" >&2; exit 1; }

# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu | debian) ;;
  *)
    echo "ERROR: automatic install supports Ubuntu and Debian only (this is ${PRETTY_NAME:-unknown})." >&2
    echo "       See https://docs.docker.com/engine/install/" >&2
    exit 1
    ;;
esac

if [ "$assume_yes" -ne 1 ]; then
  read -rp "Install Docker Engine from download.docker.com for $PRETTY_NAME? [y/N] " answer
  case "$answer" in y | Y | yes) ;; *) echo "Aborted."; exit 1 ;; esac
fi

export DEBIAN_FRONTEND=noninteractive

# Distro-packaged variants conflict with the official packages.
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    apt-get remove -y "$pkg"
  fi
done

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
[ -n "$codename" ] || { echo "ERROR: could not determine the release codename" >&2; exit 1; }
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${codename} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable --now docker
fi

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  usermod -aG docker "$SUDO_USER"
  echo "Added $SUDO_USER to the docker group (takes effect at the next login)."
fi

echo "Installed: $(docker --version), compose $(docker compose version --short)"
