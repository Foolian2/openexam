# One-shot pg_upgrade image: Postgres 18 server binaries PLUS the Postgres 16
# ones, which is the whole point — pg_upgrade needs both majors present in a
# single filesystem namespace to read the old cluster and write the new one.
# Built and thrown away by scripts/pg-upgrade.sh; never part of the running
# stack, so docker-compose.prod.yml does not reference it.
#
# Deliberately NOT built on infra/postgres/Dockerfile: wal-g plays no part in
# a pg_upgrade run (the post-upgrade base backup is pushed by the real
# postgres service afterwards), and pulling the wal-g binary in here would
# only add a network fetch to a step that must be as boring as possible.
#
# Same digest pin as infra/postgres/Dockerfile — the new cluster must be
# initdb'd by the exact server build that will then run it.
FROM postgres:18@sha256:1957b2ff3137e4ef7f3bc813e74fff50b1e1ffddc85c8b9d6f14ade972be8687

# The old major's server package, which brings its own
# /usr/lib/postgresql/16/bin — that is what pg_upgrade's -b points at.
#
# It needs its own apt source line: the base image's /etc/apt/sources.list.d/
# pgdg.list lists only its OWN major as the repository component
# ("... trixie-pgdg main 18"), so `apt-get install postgresql-16` finds
# nothing without this. The signing key is the one the base image already
# exported to /usr/local/share/keyrings/postgres.gpg.asc.
#
# No `create_main_cluster = false` needed here: the base image already sets
# it in /etc/postgresql-common/createcluster.conf, so installing the package
# does not leave a stray cluster inside the image.
RUN echo "deb [ signed-by=/usr/local/share/keyrings/postgres.gpg.asc ] http://apt.postgresql.org/pub/repos/apt trixie-pgdg 16" \
      > /etc/apt/sources.list.d/pgdg-16.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16 \
    && rm -rf /var/lib/apt/lists/*

# pg_upgrade refuses to run as root. The working directory is set by
# scripts/pg-upgrade.sh to the volume root, so pg_upgrade's own
# pg_upgrade_output.d survives a failed (--rm) run.
USER postgres
