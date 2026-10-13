-- Idempotent role/database setup for the monitoring stack, run once by the
-- one-shot monitoring-db-init service (docker-compose.prod.yml), mirroring
-- minio-init's "safe to re-run" pattern for the app's own S3 bucket setup.
--
-- Passwords are never embedded here — they arrive via psql -v substitution
-- (scripts/setup-monitoring.sh), matching how the rest of this repo keeps
-- secrets out of committed files.
--
-- \gexec runs the immediately preceding SELECT's result as SQL. Postgres has
-- no `CREATE ROLE IF NOT EXISTS` / `CREATE DATABASE IF NOT EXISTS`, so this
-- is the standard idiom: only emit the CREATE statement when a catalog
-- lookup shows the object doesn't exist yet.

-- postgres-exporter: read-only, via the built-in pg_monitor role (grants
-- pg_stat_activity/pg_stat_replication/etc. visibility with no write or DDL
-- access — see https://www.postgresql.org/docs/current/predefined-roles.html).
SELECT format('CREATE ROLE monitoring LOGIN PASSWORD %L', :'monitoring_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitoring')
\gexec

GRANT pg_monitor TO monitoring;

-- GlitchTip: owns its own database entirely, isolated from the app schema.
SELECT format('CREATE ROLE glitchtip LOGIN PASSWORD %L', :'glitchtip_db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'glitchtip')
\gexec

SELECT format('CREATE DATABASE glitchtip OWNER glitchtip')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'glitchtip')
\gexec

\connect glitchtip

-- GlitchTip's search feature depends on pg_trgm (trigram similarity).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
