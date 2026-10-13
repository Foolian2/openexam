#!/usr/bin/env bash
# Restrict the host firewall to the ports the stack needs (22/80/443, plus a
# non-standard SSH port if sshd is configured on one) and enable ufw.
# Idempotent; run as root (or with passwordless sudo).
#
# The SSH port is detected from sshd_config so enabling ufw can never lock
# the operator out on a custom SSH port. Note that Docker's published ports
# bypass ufw's iptables rules anyway — this protects the host itself and any
# non-Docker services; the documented PRD stance (DEPLOYMENT.md) is to still
# run it.
set -euo pipefail

ssh_port=$(grep -E '^Port ' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1 || true)
[ -n "$ssh_port" ] || ssh_port=22
[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (ufw needs privileges)" >&2; exit 1; }

if ufw status 2>/dev/null | grep -q "Status: active"; then
  # Ensure the rules exist; harmless if they already do.
  ufw allow "$ssh_port,80,443/tcp" >/dev/null 2>&1 || {
    ufw allow "$ssh_port/tcp" >/dev/null
    ufw allow 80,443/tcp >/dev/null
  }
  echo "ufw already active — ensured rules (SSH $ssh_port, 80, 443)."
else
  ufw allow "$ssh_port,80,443/tcp" >/dev/null
  ufw --force enable
  echo "ufw enabled — allowed SSH ($ssh_port), 80, 443."
fi
