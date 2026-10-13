#!/usr/bin/env bash
# Verify the deployment domain's A record actually points at this host.
#
#   exit 0 — DNS is ready (real TLS can be issued)
#   exit 1 — DNS resolves somewhere else / not at all (yet)
#   exit 2 — could not determine this host's public IP or resolve the domain
#
# The A record is queried from a public resolver (8.8.8.8) rather than the
# system one, so a stale local cache from before the record was repointed
# doesn't produce a false negative. Caveat: a CDN/Cloudflare-proxied record
# resolves to the proxy's IPs, not this host's — grey-cloud (proxying off) is
# required for the ACME webroot challenge anyway, so treat that as "not ready".
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN=$(grep ^DOMAIN .env.prod | cut -d= -f2)
[ -n "$DOMAIN" ] || { echo "ERROR: DOMAIN not set in .env.prod" >&2; exit 2; }

public_ip=$(curl -sf --max-time 10 https://api.ipify.org 2>/dev/null \
  || curl -sf --max-time 10 https://ifconfig.me/ip 2>/dev/null \
  || true)
if [ -z "$public_ip" ]; then
  echo "WARN: could not determine this host's public IP (no outbound HTTPS?)" >&2
  exit 2
fi

dns_ips=""
if command -v dig >/dev/null 2>&1; then
  dns_ips=$(dig +short "@8.8.8.8" "$DOMAIN" A 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
fi
if [ -z "$dns_ips" ]; then
  dns_ips=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)
fi
if [ -z "$dns_ips" ]; then
  echo "WARN: could not resolve $DOMAIN (no dig and no getent, or no records)" >&2
  exit 2
fi

if printf '%s\n' "$dns_ips" | grep -qx "$public_ip"; then
  echo "DNS OK: $DOMAIN resolves to this host ($public_ip)"
  exit 0
fi

echo "DNS NOT READY: $DOMAIN resolves to ($(printf '%s' "$dns_ips" | tr '\n' ' ')) — this host is $public_ip"
echo "  Point the A/AAAA record at $public_ip (proxying off) and re-run, or"
echo "  run ./scripts/issue-cert.sh once the record has propagated."
exit 1
