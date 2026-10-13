# Postgres + wal-g, for WAL archiving / point-in-time recovery (DEPLOYMENT.md
# "Point-in-time recovery"). docker-compose.prod.yml's postgres service
# builds from this instead of pulling a bare image, because wal-g has no
# officially published Alpine/musl build (only glibc Linux binaries) — the
# rest of this stack's images are Alpine where possible, but that tradeoff
# doesn't apply here. Debian glibc is the standard, well-tested target for
# wal-g's prebuilt binary, so this switches the base image family rather
# than fighting musl compatibility.
#
# postgres:18 (18.6, Debian trixie — the default variant moved from bookworm
# to trixie in 18) — digest-pinned per repo convention
# (docker-compose.prod.yml's header comment). Bump deliberately and
# re-verify, same as every other pinned image here.
#
# Upgrading the data directory from a 16 cluster is NOT something starting
# this image does for you — see scripts/pg-upgrade.sh and DEPLOYMENT.md's
# "Major Postgres version upgrade". Note also that 18's official image made
# PGDATA version-specific and moved its declared VOLUME; docker-compose.prod.yml
# pins PGDATA explicitly to keep the existing mount authoritative.
FROM postgres:18@sha256:1957b2ff3137e4ef7f3bc813e74fff50b1e1ffddc85c8b9d6f14ade972be8687

# curl: fetches the wal-g binary below (not part of the base postgres
# image). Left installed rather than removed after use — wal-g itself makes
# its own S3 requests directly, so nothing at runtime needs curl, but it's a
# small package and a useful tool to have on hand when debugging the
# container. apt lists are still cleaned up to keep the layer lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# wal-g v3.0.7, linux/amd64 glibc build. Checksum captured directly from this
# release asset (github.com/wal-g/wal-g/releases/download/v3.0.7/) — bump
# deliberately and re-verify against the new release's own published
# checksum before adopting a newer version, same policy as every
# digest-pinned image in this repo.
ARG WALG_VERSION=v3.0.7
ARG WALG_SHA256=a573efb1d874ecfdd773a62cd718eb39adc1b065d27030046ecde9d252b291a4
RUN curl -fsSL -o /tmp/wal-g.tar.gz \
      "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-ubuntu-20.04-amd64.tar.gz" \
    && echo "${WALG_SHA256}  /tmp/wal-g.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/wal-g.tar.gz -C /tmp \
    && install -m 0755 /tmp/wal-g-pg-ubuntu-20.04-amd64 /usr/local/bin/wal-g \
    && rm -rf /tmp/wal-g.tar.gz /tmp/wal-g-pg-ubuntu-20.04-amd64
