# Production Deployment

Single-server Docker Compose deployment per PRD §16 (target: Hetzner CX22+,
Ubuntu 24.04, Docker Engine with Compose v2).

## Architecture

```
Browser ── 443 ──> nginx ──> web:3000        (Next.js, 6 replicas)
                     └─ /ws/      ──> ws-backend:8080  (Go, WebSockets)
web / ws-backend ── internal network ──> postgres:5432, redis:6379
postgres (wal-g) ── verified SSH tunnel ──> SFTP host (optional; disabled by default)
```

Web is 6 replicas by default, sized for an 8 vCPU host running the optional
monitoring stack (the reasoning is in the `deploy` comment of `web` in
`docker-compose.prod.yml`). On a 4 vCPU / 8 GB box, lower `deploy.replicas`
to 4, or to 3 if you also run monitoring on it.

- Only nginx publishes host ports (80/443). Postgres and Redis sit on an
  `internal: true` network with no host or internet access (PRD §12.3).
- Uploaded exam files are stored in Postgres (`AnswerFile`) and served by
  the web tier's download route as forced downloads.
- MinIO is removed from production. Existing `openexam-prod_minio_data`
  volumes are retained for access to historical archives.
- PITR is optional: `WALG_STORAGE_BACKEND=disabled` (default) stops WAL
  archiving and skips scheduled PITR backups. Daily `pg_dump` continues.
  Select `sftp` after configuring the encrypted backup credentials below.
  Rollbacks to images predating Postgres uploads require the old MinIO stack.
- `migrate` is a one-shot service running `prisma migrate deploy`; the web
  replicas only start after it succeeds.
- Redis runs with AOF (`--appendfsync everysec`): at most ~1 s of in-flight
  answers lost on a crash.

## First-time server setup

1. **DNS**: point your domain (`A`/`AAAA`) at the server. The setup script
   checks this (public resolver vs. this host's public IP) and issues the real
   TLS cert automatically when it's ready — run the script before DNS
   propagates and it finishes on a placeholder cert instead, then re-run it
   (or just `scripts/issue-cert.sh`) once the record resolves here.
2. **One command**, guided:

   ```bash
   git clone <repo> /opt/openexam && cd /opt/openexam
   ./openexam install
   ```

   The wizard checks the server first (root/sudo, OS, RAM and disk, Docker —
   offering to install Docker Engine + Compose from Docker's apt repository
   via `scripts/install-docker.sh` — ports 80/443, a clean checkout, the
   public IP), asks for the domain and admin email, checks the A record
   against the public IP (re-check, or continue on the placeholder cert), asks
   for the school's details on the legal pages (step 3), and asks for the optional parts that would otherwise mean hand-editing
   `.env.prod`: SMTP, Microsoft login (tenant GUID validated like
   `lib/env.ts`), monitoring, offsite backups and the first admin account.
   After a summary it runs the chain below, then sends an SMTP test mail
   (`scripts/smtp-test.ts`; on failure: re-enter or skip), creates the admin
   (`scripts/create-teacher.ts`), pushes the first offsite backup, and runs
   `scripts/setup-monitoring.sh` if chosen. Re-running it on an existing
   install never regenerates `.env.prod`; it offers update / repair instead.
   Unattended: `./openexam install --yes --domain … --email …` (see
   `./openexam install --help` for the environment variables it reads).

   Without the wizard, `./scripts/setup-prod.sh openexam.ch` runs the same
   chain non-interactively. Each step is also runnable on its own and
   idempotent:
   - `scripts/check-dns.sh` — is `DOMAIN`'s A record pointing at this host?
     (exit 0/1/2; also run by `issue-cert.sh` so certbot never fails on
     opaque DNS errors)
   - `scripts/gen-env-prod.sh [domain]` — writes `.env.prod` (chmod 600,
     gitignored) from `.env.example` with fresh random secrets. Refuses to
     overwrite an existing `.env.prod` — its values initialized the
     Postgres volumes, so regenerating would silently break the stack.
   - `scripts/bootstrap-cert.sh` — self-signed placeholder cert at
     `certs/live/openexam` so nginx can start before the real one exists.
   - `scripts/deploy.sh` — build, migrate, roll, nginx reload (see below).
   - `scripts/create-cap-site-key.sh` — creates the Cap site key via the
     admin API (`/server/keys` inside the Docker network, logged in with
     `CAP_ADMIN_KEY`) and writes the real `NEXT_PUBLIC_CAP_WIDGET_ENDPOINT` /
     `CAP_SECRET_KEY` into `.env.prod`. No dashboard, no SSH tunnel.
     Idempotent; after it changes anything you must redeploy (the widget
     endpoint is baked into the client bundle at build time).
   - a second `deploy.sh` bakes the site key into the web image.
   - `scripts/issue-cert.sh` (only when DNS is ready) — real Let's Encrypt
     cert. If `certs/live/openexam` holds the self-signed placeholder it is
     moved aside first, so certbot writes the real cert to the path nginx
     hardcodes instead of tripping its "live directory exists" conflict
     (which would park the cert in a stray `live/openexam-0002` while nginx
     keeps serving the placeholder). Issues via the ACME webroot through
     nginx and reloads it. Idempotent: with a renewal config it uses
     `certbot renew` semantics and does nothing while the cert has >30 days
     left.
   - `scripts/install-cron.sh` — cert renewal (twice daily, `renew` skips
     when <30 days left) + daily backup cron lines for the deploy user, plus
     the 03:15 offsite push once an offsite target exists. Each line is
     checked separately, so re-running only adds what's missing.
   - `scripts/configure-firewall.sh` — ufw: SSH port (detected from
     `sshd_config`) + 80/443, enabled.

3. **Legal pages**: the wizard asks for the school's details (name, address,
   privacy contact email, hosting provider); with `setup-prod.sh` the first
   run stops right after writing `.env.prod` — fill in `LEGAL_CONTROLLER_NAME`,
   `LEGAL_CONTROLLER_ADDRESS`, `LEGAL_CONTACT_EMAIL` and
   `LEGAL_HOSTING_PROVIDER` and re-run the script. Optionally add the
   `LEGAL_DPO_*` data protection officer, `LEGAL_RETENTION_NOTE`, and
   `LEGAL_BACKUP_PROVIDER` if you use the SFTP backups. They fill the public
   `/datenschutz` and `/impressum` pages; the web tier refuses to boot without
   them, `deploy.sh` checks them before building, and `./openexam update`
   asks for any that are missing. The wording is a template, not legal
   advice — have the school's data protection officer review the rendered
   pages before students use the platform.
4. Optional, if you skipped them in the wizard (or used `setup-prod.sh`):
   add `SMTP_*` / Microsoft login values to `.env.prod`, then
   `./scripts/deploy.sh`; `./openexam backup-offsite` for offsite backups;
   `./openexam create-teacher` for an admin login.

That's it — DNS record + one command. Everything below is background
knowledge for operating the install. `./openexam status` and
`./openexam doctor` (exit 1 on problems — placeholder or short secrets,
mismatched origins, missing legal-page details, stopped services, unregistered captcha key, an expiring
certificate, a stale backup, a full disk) are the quick health checks.

## Deploying updates

```bash
cd /opt/openexam && ./openexam update     # or: git pull && ./scripts/deploy.sh
```

`./openexam update` shows the incoming commits first (and warns when they
include migrations), pulls with `--ff-only`, runs `deploy.sh`, and offers
`scripts/rollback.sh <the tag that was running>` if the deploy fails.

`deploy.sh` builds the images, applies pending Prisma migrations, rolls the
containers, and reloads nginx (required: nginx resolves the web replicas' IPs
at startup, and they change when containers are replaced).

It refuses to run with a dirty working tree. Images are tagged with the
deployed commit's short SHA (`openexam-web:a1b2c3d`), `:latest` is moved to
match, the tag is appended to `.deploy-history`, and all but the last five
builds are untagged. That surviving previous image is what makes the next
section possible.

### Recreating single containers by hand

`deploy.sh` handles the normal path. When you bypass it to recreate one
service — a changed bind-mounted config, say — two things bite.

**nginx and nginx-log-exporter must be recreated together.** The exporter runs
with `network_mode: "service:nginx"` so that nginx can ship its metrics access
log to it over loopback and never resolve a container name while parsing its
config. That means the exporter lives *inside nginx's network namespace*.
Recreating nginx destroys that namespace, and the exporter — still running,
still reported `Up` — is left orphaned in a namespace that no longer exists.
Nothing listens on `:4040` any more, the `nginx-log` scrape target goes down,
and `ContainerDown` fires two minutes later. `--no-deps` suppresses exactly the
dependency that would have saved you:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  up -d --force-recreate --no-deps nginx nginx-log-exporter
```

**A bind-mounted file that was rewritten needs `--force-recreate`, not a
reload.** Docker binds a single file by inode. Editors, `git checkout` and
`git pull` all replace files rather than writing in place, so the new content
lands on a *new* inode and the running container keeps serving the old one. It
does not matter how many times you reload — the process cannot see the file you
edited, and alerts built on the new config silently evaluate against metrics
that never exist.

To check whether a container is serving stale config, compare the file it has
against the file on disk rather than trusting the mount:

```bash
docker exec openexam-prod-nginx-1 md5sum /etc/nginx/nginx.conf.template
md5sum nginx/nginx.conf
```

### Rolling back

```bash
./scripts/rollback.sh              # to the previous deploy
./scripts/rollback.sh a1b2c3d      # to a specific tag
```

Re-points `web` and `ws-backend` at an image already on the host and reloads
nginx. No build, so it completes in seconds rather than the several minutes a
`git checkout && deploy.sh` rebuild costs — and it does not depend on that
older commit still being buildable against today's registries and lockfiles.

**It will refuse if the database is ahead of the target commit**, listing the
migrations that were applied after it. That is the situation where rolling
back is genuinely dangerous: the old code would run against a newer schema.

- If every listed migration is additive — a nullable column, a new table, an
  index — the old code simply never looks at it. Re-run with `--force`.
- If any of them dropped or renamed something the old code reads, do not force
  it. Restore from backup instead ("Point-in-time recovery" below).

Which of those you are in is decided when the migration is *written*, not when
it is rolled back. Keep migrations expand-contract and rollback stays a
non-event: add the new column nullable and start writing both; remove the old
one in a later release, once no deployed version still reads it. A migration
that adds a column and drops another in the same release makes that release a
one-way door.

Rollback does not touch the database, and it does not touch `postgres` — see
that service's comment in `docker-compose.prod.yml`. `.deploy-history` is left
alone, so `./scripts/deploy.sh` rolls forward again whenever you are ready.

### One-time: the Better Auth 1.7 account-identity migration

The 1.7 upgrade changes how a Microsoft account row is identified: Entra
accounts move from the app-pairwise `sub` claim to the directory-stable
`oid`. A schema migration cannot do that rewrite — only the stored ID tokens
carry the `oid`, and they are encrypted at rest — so an existing Microsoft
row would be orphaned and the next sign-in would create a second account for
the same person.

**Without Microsoft login there is nothing to do**: credential accounts are
already keyed by the linked user's id, so the ordinary `./scripts/deploy.sh`
covers it.

**With Microsoft login**, run the backfill first, once, in a maintenance
window with the web tier stopped (a sign-in landing between the backfill and
the unique index creates exactly the duplicate the index then refuses):

```bash
# `docker compose run` reuses the service's existing image, and every command
# here needs .env.prod for the database password, AT_REST_ENC_KEY and the
# Microsoft settings — same invocation the scripts in scripts/ use.
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.prod)

# 0. Back up first — this rewrites account rows.
./scripts/backup.sh

# 1. Stop authentication writes.
"${COMPOSE[@]}" stop web

# 2. Rebuild the migrate image: this runs before deploy.sh, so the installed
#    image still predates the migration script.
"${COMPOSE[@]}" build migrate

# 3. Dry run: reports what each row would get, and why any row cannot be
#    resolved. Writes nothing.
"${COMPOSE[@]}" run --rm migrate \
  pnpm tsx scripts/migrate-account-identity.ts

# 4. Apply once the dry run is clean.
"${COMPOSE[@]}" run --rm migrate \
  pnpm tsx scripts/migrate-account-identity.ts --apply

# 5. Schema (the unique index) and the web tier back up, as usual.
./scripts/deploy.sh
```

The script reads each Microsoft account's stored ID token, verifies its
signature against the tenant's published keys and copies the `oid` claim.
Two cases need an operator decision:

- **The signing key was retired.** Microsoft rotates keys, so an older token
  may no longer be verifiable. Prefer `--mapping=FILE` with a
  `{"<old accountId>": "<oid>"}` export from Entra;
  `--allow-unverified-id-tokens` accepts the stored token on its
  issuer/audience/tenant claims alone.
- **No ID token was ever stored.** Only `--mapping=FILE` resolves those.
  Better Auth cannot derive `oid` from the old row, and letting Microsoft
  sign-in run before the mapping exists creates a *second* account for the
  same person.

The script refuses to finish while any row is unresolved or two rows resolve
to the same identity. If the schema migration runs first anyway it fails on
the unique index without committing anything; recover with

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate \
  pnpm prisma migrate resolve --rolled-back 20260916120000_account_identity_drop_issuer
```

then run the backfill and deploy again.

#### If you are upgrading from before 2026-08-20

`20260820150000_account_identity_issuer` was written for Better Auth 1.7.0's
`(issuer, accountId)` account identity. 1.7.3 reverted that upstream, and
`20260916120000_account_identity_drop_issuer` drops the column again — but
the older migration still runs first, and it sets `account.issuer` NOT NULL.
A deployment that never applied it and has OAuth account rows has nothing to
fill that column with, so give the doomed column throwaway values before
deploying:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres \
  psql -U openexam -d openexam <<'SQL'
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" TEXT;
UPDATE "account" SET "issuer" = 'local:pre-revert:' || "id" WHERE "issuer" IS NULL;
SQL
```

The values are per-row unique, so they satisfy that migration's NOT NULL and
its unique index, and the next migration drops the column. The Microsoft
`sub` → `oid` rewrite above is unaffected: it is still required, and still
the backfill script's job.

Also update the app registration in Entra ID before bringing the web tier
back: the redirect URI moves from
`https://<host>/api/auth/oauth2/callback/microsoft-entra-id` to
`https://<host>/api/auth/callback/microsoft-entra-id` (1.7 runs generic OAuth
providers on the built-in social-provider path). Register the new URI
alongside the old one and drop the old one after the deploy, so a login
started before the switch still lands.

## Monitoring & Alerting

Optional — the exam stack runs fine without it, exactly as before this was
added. Adds: Prometheus (metrics), Grafana (dashboards), Alertmanager
(email alerts, via the same SMTP_* config as auth emails), node/postgres/
redis/nginx-exporter, and GlitchTip (self-hosted, Sentry-protocol-compatible
error tracking). No 3rd-party/SaaS dependency: every component is
self-hosted, and everything reuses infrastructure already in the stack
(Postgres, Valkey, your SMTP relay) rather than adding new ones.

### Sizing

The baseline 4vCPU/8GB tier this stack already targets (`web`'s replica-count
comment in `docker-compose.prod.yml`) has effectively no spare room once the
monitoring stack's ~10 extra containers are added — trimming `web` to 3
replicas makes room, but that still leaves thin margin. The shipped default
of 6 replicas assumes the recommended box below.
**Recommended: an 8vCPU/16GB box** if you're running monitoring, not
the 4vCPU/8GB baseline. If you can't size up, skip this section entirely —
nothing else in the stack depends on it.

### Setup

All monitoring services sit behind the `monitoring` compose profile, so
nothing of it runs until you set it up: `deploy.sh` adds
`--profile monitoring` by itself once `setup-monitoring.sh` has rendered
`monitoring/alertmanager/alertmanager.yml`. When you run `docker compose`
by hand against a monitoring service, add `--profile monitoring` too.
Alertmanager's container also needs `ALERTMANAGER_CONFIG_GID` from
`.env.prod` (written by `setup-monitoring.sh`). When it is missing — a
fresh checkout next to an old `.env.prod`, say — starting the monitoring
profile fails with `unable to find group run-scripts-setup-monitoring.sh-first`;
re-run `./scripts/setup-monitoring.sh` instead of touching the compose
file. Commands that leave the profile off are unaffected.

1. Fill in the monitoring section of `.env.prod` (see `.env.example`'s
   comments): `GRAFANA_ADMIN_PASSWORD`, `GLITCHTIP_SECRET_KEY`,
   `GLITCHTIP_DB_PASSWORD`, `MONITORING_DB_PASSWORD`, `ALERT_EMAIL_TO`. Leave
   `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` empty for now. A `.env.prod`
   written by `gen-env-prod.sh` (or `./openexam install`) already has
   generated values for all of these except `ALERT_EMAIL_TO`.
2. ```bash
   ./scripts/setup-monitoring.sh
   ```
   Brings up every monitoring service, renders Alertmanager's config from
   `.env.prod`'s SMTP_* values, and installs the PITR + cert-expiry cron
   lines. Prints the SSH-tunnel commands for each dashboard on success.
   The rendered config is mode `0640`, owned by the setup user, and placed
   in the dedicated `openexam-monitoring` group — created on the first run
   (the one step that may ask for sudo; re-runs reuse it) and recorded as
   `ALERTMANAGER_CONFIG_GID` in `.env.prod`. Compose hands that group to
   Alertmanager's unprivileged user as its only supplementary group, so the
   SMTP settings are readable inside the container while the group has no
   human members who could read them on the host — inheriting the setup
   user's primary group would leak `SMTP_PASSWORD` to everyone sharing it
   (`users`, `staff`, an AD default group). Without root to create the
   group, setup falls back to the setup user's own group, but only when
   that group has no other members (the Debian/Ubuntu per-user default); on
   a shared primary group it refuses and prints the two commands (create
   `openexam-monitoring`, assign the config to it) to run first.
   Setup also works when the setup user has no crontab yet; rerunning it
   keeps one entry for each monitoring job.
3. **GlitchTip project setup** (one-time, manual — GlitchTip has no API for
   this that fits a script): open registration is disabled
   (`ENABLE_OPEN_USER_REGISTRATION: "false"`), so create the admin user
   inside the container first:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod \
     exec glitchtip-web python manage.py createsuperuser
   ```
   Then tunnel to it (`ssh -L 8001:localhost:8001 <user>@<host>`), open
   `http://localhost:8001`, log in and create a project, and copy its DSN.
   Set `SENTRY_DSN` **and** `NEXT_PUBLIC_SENTRY_DSN` in `.env.prod` to
   `http://glitchtip-web:8000/<project-id>` (both server and browser
   capture point at the same internal address — browser events are relayed
   through `app/api/monitoring/tunnel`, never sent to GlitchTip directly, so
   this value is safe to be "internal-looking" in the client bundle). Then
   `./scripts/deploy.sh` to rebuild with it baked in.

### Reaching the dashboards

Nothing here is published to the internet — every dashboard is reachable
only via SSH tunnel, the same pattern this stack already uses for the Cap
CAPTCHA admin dashboard:

```bash
ssh -L 9090:localhost:9090 -L 9093:localhost:9093 -L 3001:localhost:3001 -L 8001:localhost:8001 <user>@<host>
```

| Service | URL | Notes |
|---|---|---|
| Prometheus | http://localhost:9090 | raw PromQL / target status |
| Alertmanager | http://localhost:9093 | active/silenced alerts |
| Grafana | http://localhost:3001 | `admin` / `$GRAFANA_ADMIN_PASSWORD`; the "OpenExam Overview" dashboard is pre-provisioned |
| GlitchTip | http://localhost:8001 | error tracking dashboard |

### Alerting

Alertmanager emails `ALERT_EMAIL_TO` for: any container down for 2+ minutes,
disk <15% free, Postgres connections >80% of `max_connections`, a stale
wal-g or pg_dump backup (no success recorded in >25h), a TLS cert expiring
in <14 days, and nginx active connections approaching the ~2072-connection
ceiling `nginx.conf` documents — plus the SLO and application alerts below.
See `monitoring/prometheus/rules/alerts.yml` for the exact rules. This is the
**only** alert-email path — GlitchTip's own built-in per-issue emails are
left disabled on purpose, so there's one inbox to watch, not two; check
GlitchTip's dashboard directly for error details.

### Checking that an alert can still fire

A Prometheus rule whose metric does not exist is **not** reported as broken. The
expression simply evaluates to an empty vector, the rule's `health` stays `ok`,
and it sits there looking perfectly healthy while being incapable of ever
firing. There is no warning anywhere in the UI.

That is not a theoretical failure. Between 2026-08-23 and 2026-08-27,
`HighHttpErrorRate`, `RestLatencySLOBreach` and `PageLoadSLOBreach` were all
dead — nginx was serving a stale config and never shipped its metrics access
log, so `nginx_http_response_count_total` did not exist — and every one of them
read `health=ok` throughout. A 17-hour CAPTCHA outage passed with zero alerts.

So after any change to nginx's logging, the exporters, or the rules, confirm
the underlying series actually exist rather than trusting rule health:

```bash
# every metric referenced by a rule should return a non-zero count
docker exec openexam-prod-prometheus-1 wget -qO- \
  'http://127.0.0.1:9090/api/v1/query?query=count(nginx_http_response_count_total)'
docker exec openexam-prod-prometheus-1 wget -qO- \
  'http://127.0.0.1:9090/api/v1/query?query=count(nginx_http_response_time_seconds_hist_bucket)'
docker exec openexam-prod-prometheus-1 wget -qO- \
  'http://127.0.0.1:9090/api/v1/query?query=probe_success'
```

An empty `result` array means the alert that depends on it is inert. Note that
the access-log metrics only appear once nginx has served a request since its
last restart, so generate a little traffic before concluding anything.

Related: a target can report `up` while serving nothing useful. Prometheus
counts an HTTP 200 with an empty body as a successful scrape, which is exactly
how the orphaned `nginx-log` exporter looked healthy while exporting zero
series.

### Service-level objectives

The `openexam-slo` rule group holds production to the targets the load tests
were run against:

| Objective | Threshold | Alert |
| --- | --- | --- |
| HTTP error rate | < 1% of requests 5xx | `HighHttpErrorRate` (critical, 5m) |
| REST latency | p95 < 200 ms | `RestLatencySLOBreach` (warning, 10m) |
| Page render | p95 < 2 s | `PageLoadSLOBreach` (warning, 10m) |
| WS answer-ack | p95 < 100 ms | `WsAckLatencySLOBreach` (warning, 10m) |
| WS queue wait | p99 < 1 s | `WsInboundQueueBacklog` (critical, 5m) |

Those numbers held to **1 600 concurrent students** in testing and failed at
2 400, so a sustained breach usually means either real growth past the tested
capacity or a regression — check which before treating it as a bug.

The `for:` durations are long on purpose. Exam start is a thundering herd by
design; a spike as a class joins is normal and should not page anyone. A
breach that persists for ten minutes is not normal.

Where the numbers come from: HTTP error rate and latency are derived from the
nginx access log, which `nginx` ships over UDP syslog to `nginx-log-exporter`
(`monitoring/vector/vector.yaml`). `stub_status`, which the older
`nginx-exporter` reads, exposes neither status codes nor response times, so it
cannot produce these. That exporter runs as a sidecar inside nginx's network
namespace — nginx resolves a syslog target when it parses its config and dies
if it cannot, so pointing it at a container name would make the edge proxy for
the whole site depend on an optional monitoring container being present. Over
loopback it does not. Prometheus therefore scrapes it at `nginx:4040`.

The service is named `nginx-log-exporter` but runs Vector, which replaced the
unmaintained `prometheus-nginxlog-exporter`. `vector.yaml`
reproduces the old metric names, labels and bucket boundaries exactly, so
nothing downstream changed. Two unread summary metrics
(`nginx_http_response_time_seconds`, `nginx_http_upstream_time_seconds`) are
gone: Vector renders a distribution as a histogram *or* a summary, and only
the `_hist` histograms were ever queried. The metrics log carries a bounded `$route` label and
never a query string — see the comment above `log_format metrics` in
`nginx/nginx.conf` for why that matters. WebSocket timings come from
`ws-backend` itself, since nginx sees the upgrade but not the frames inside it.

**Reading a breach.** `WsInboundQueueBacklog` and `WsAsyncQueueSaturated`
lead `WsAckLatencySLOBreach`: they mean the per-room goroutine is falling
behind its own I/O while CPU stays low. Idle CPU beside a long tail is
queueing, and adding vCPU does not fix it.

The `openexam-app` group covers signals that had been exported for a while
with nothing watching them: `GradingRetriesExhausted` (critical — a submitted
exam is ungraded and needs a human), `AuditLogWriteFailures` (critical — the
compliance record has a hole in it), `RateLimiterFailClosed` (usually a Redis
outage locking people out of sign-in, not an attack) and
`WsAsyncQueueSaturated`.

### Log rotation

Every service now has a bounded `logging:` block (previously unset
anywhere, i.e. unbounded growth). Worst case, all containers at their caps
simultaneously: roughly 700–800 MB — budget for that on top of your data
volumes when sizing disk. This is rotation, not aggregation: `docker compose
logs <service>` is still the only way to search across containers; there's
no centralized log search in this stack (a Loki/Promtail addition, reusing
this same Grafana instance, is a reasonable future follow-up, not part of
this).

## Point-in-time recovery

Optional encrypted SFTP backups add continuous WAL archiving via
[wal-g](https://github.com/wal-g/wal-g) to the existing daily `pg_dump`.
They are disabled by default. Follow "Encrypted SFTP backups" below to
configure and enable them; disabled installations have daily-dump recovery.

- **Storage**: encrypted archives on the configured SFTP host.
- **Continuous archiving**: `postgres`'s `archive_command` pushes each WAL
  segment via `wal-g wal-push`, with `archive_timeout=60` bounding RPO to
  ≤60s even during quiet periods.
- **Base backups**: `scripts/pitr-backup.sh` runs `wal-g backup-push` daily
  at 4am (installed by `setup-monitoring.sh`, independent of
  `scripts/backup.sh`'s 3am `pg_dump` cron line) and retains the last 7 full
  backups (`wal-g delete retain FULL 7 --confirm`, which also prunes WAL no
  longer needed by any retained backup).

### Restore

**Destructive** — unlike every other script in `scripts/`, `pitr-restore.sh`
is not safe to run casually; it overwrites `postgres_data`'s current
contents. Requires an explicit `--yes-i-am-sure` flag.

```bash
# Restore the latest backup, no WAL replay past it:
./scripts/pitr-restore.sh --latest --yes-i-am-sure

# Historical --target-time restores are currently disabled.
```

**Historical targets are disabled in the in-place restore script.** Selecting
an older backup does not prove that its data objects and required WAL are
complete. The script rejects `--target-time` before stopping services or
changing database files. Historical recovery must first be performed and
validated on a scratch volume; only a verified recovered cluster may replace
live data. Automated staging and validation are required before re-enabling
this option. Continuous WAL archiving and base backups remain enabled.

The supported `--latest` flow below remains destructive. It now takes an
automatic safety dump into `./backups/` before anything is stopped and
refuses to proceed if that dump fails or comes back empty, and it fetches
the base backup into a staging directory so a failed fetch leaves the live
data directory intact. Neither guard substitutes for independent offsite
copies or a rehearsed restore drill — take and verify those first.

This stops `web`/`ws-backend`/`postgres`, fetches the most recent base
backup into `postgres_data`, configures Postgres with `recovery_target =
'immediate'` so recovery stops at the base backup's first consistent state
instead of replaying archived WAL past it, starts it in recovery, and waits
for it to promote — then prints the command to bring the app tier back up.
Before stopping anything it takes the safety dump, starts the `walg-sftp`
tunnel, waits for it to report healthy, and lists the archive's base
backups; if any of those fail, nothing is changed. Recovery settings are
rewritten rather than appended, so a `recovery_target*` left in
`postgresql.auto.conf` by an older restore cannot make Postgres refuse to
start with "multiple recovery targets specified". Watch progress with
`docker compose -f docker-compose.prod.yml -f docker-compose.sftp.yml
--env-file .env.prod logs -f postgres`. Use the command the script prints
(it includes the SFTP overlay): a bare `-f docker-compose.prod.yml` command
recreates `postgres` without archiving.

### Restore drill (do this before you need it for real)

Never rehearse against the live volume. Run a base backup
(`./scripts/pitr-backup.sh`), make a few throwaway writes, then restore into
a **scratch** volume instead of `postgres_data`:

```bash
# Both files: the overlay supplies the SFTP prefix, keys and tunnel.
COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.sftp.yml --env-file .env.prod)
# The archive is reachable only through the tunnel; `run --no-deps` below
# does not start it.
"${COMPOSE[@]}" up -d --wait walg-sftp
"${COMPOSE[@]}" run --rm --no-deps \
  -v pitr_drill_data:/var/lib/postgresql/data --entrypoint sh postgres -c '
    rm -rf "$PGDATA"/*
    wal-g backup-fetch "$PGDATA" LATEST
    pg_ctl start -D "$PGDATA" -o "-c archive_mode=off"
    sleep 3
    psql -U openexam -c "SELECT count(*) FROM \"Exam\";"
    pg_ctl stop -D "$PGDATA"
  '
docker volume rm pitr_drill_data
```

Confirm the restored row counts match what you expect as of the backup, not
including the throwaway writes made after it. Recommended cadence:
quarterly, or after any major schema change.

## Major Postgres version upgrade

`scripts/pg-upgrade.sh` upgrades the cluster in place with `pg_upgrade
--swap`. Read this whole section first: unlike everything else in
`scripts/`, this one cannot be undone.

### What makes it irreversible

`--swap` *moves* the old cluster's data files into the new cluster instead
of copying them, which is what makes it fast — and what means that from the
moment the transfer starts, there is no old cluster left. The pre-upgrade
`pg_dump` the script takes is the only way back: restore it into a
`postgres:16` container. Keep it offsite before you start.

The WAL archive is a second, easier-to-miss casualty. Everything already in
the configured archive belongs to the old cluster and can only
be restored with the old major's binaries. The script pushes a fresh wal-g
base backup at the end to establish a new PITR baseline; until that
completes, point-in-time recovery of the upgraded cluster is not available.

### Before the window

1. **Rehearse, in two steps.** Note that these prove different things and
   that the order matters — a data directory is not portable across major
   versions, so the drill above cannot simply be pointed at the new image.

   a. **Rehearse the upgrade itself.** Clone the production volume to a
      scratch volume and run `scripts/pg-upgrade.sh` against a stack pointed
      at the copy. This is what surfaces a cluster the upgrade will refuse —
      an extension with no Postgres 18 build, say — while refusing is still
      free. Never rehearse against production.

   b. **Point the app tier at the upgraded scratch cluster and load a
      page.** Do not skip this because the database "came up fine" — a
      cluster can be healthy, hold every row, and still be unreachable by
      the application. `pg_upgrade` does not carry `pg_hba.conf` across, and
      a bare `initdb` admits `local` and `127.0.0.1` only, so containers on
      the compose network are refused while `pg_isready` and every psql
      check you would think to run from inside the container all pass.
      Prisma reports it as `P1010 User was denied access on the database
      <container-ip>`, which names neither the file nor the cause.

      `scripts/pg-upgrade.sh` now copies `pg_hba.conf` and `pg_ident.conf`
      from the old cluster for exactly this reason. The step stays in the
      drill because it is the only one that exercises the whole path — auth,
      network, migrations, the app — rather than the conversion alone.

   c. **Then drill wal-g against the upgraded scratch cluster.** Only now
      does a Postgres 18 cluster exist to back up: push a base backup from
      it and restore that. Running the drill above against the new image
      instead would fetch `LATEST` from the live archive, which is
      necessarily a Postgres 16 base backup, and fail on an incompatible
      data directory before wal-g itself was tested at all.

   This is what actually proves wal-g handles the new cluster — the wal-g
   version pinned in `infra/postgres/Dockerfile` publishes no explicit
   compatibility matrix, so "the version bump looked fine" is not evidence.

   A rehearsal that stops after (a) proves the conversion and nothing else.
   That gap is not hypothetical: it is how the 16 → 18 upgrade reached
   production with an unreachable database.
2. **Get a dump offsite** (`./scripts/backup.sh`, then the `rclone` line
   from "Get backups off the host"). On the same host it is not a rollback:
   after the swap this dump is the only way back, and a disk that takes the
   database takes it too.
3. **Read the target minor's release notes.** 18.6's first three security
   entries call for configuration adjustments and data cleanups after
   updating.
4. **Check what else changed in the same commit.** `pg-upgrade.sh` ends by
   bringing the stack back up, so any other image change on that commit
   ships in the same window, under the same downtime, with attention
   elsewhere. A sidecar swap is the dangerous shape: `web` and `ws-backend`
   declare `depends_on` with health conditions, so a sidecar that cannot
   start holds the whole app tier down even though the database is fine.

   Treat "the new image reads the old volume" as a claim to verify, not a
   property to assume. The 16 → 18 window also carried a redis:7 → Valkey 9
   swap documented as volume-compatible; Valkey reads RDB v11, the volume
   was v12, and the app tier never came back. Persistence formats are the
   thing to check, in the drill, on a copy of the real volume.

### Running it

```bash
./scripts/pg-upgrade.sh --yes-i-am-sure
```

It stops the app tier and Postgres, builds a throwaway image carrying both
majors' binaries (`infra/postgres/upgrade.Dockerfile`), runs `pg_upgrade
--check` and then the upgrade, brings everything back up, runs
`vacuumdb --analyze-in-stages`, and pushes the new PITR baseline. Downtime is
minutes rather than hours — `--swap` renames rather than copies, and 18
carries planner statistics across, so there is no post-upgrade window of
bad plans while `ANALYZE` catches up.

Data checksums are off on the existing cluster and 18's `initdb` turns them
on by default; `pg_upgrade` requires the two to agree, so the script matches
the old cluster by default. Pass `--enable-checksums` to turn them on as
part of the same window instead — it rewrites every page, so budget downtime
roughly proportional to database size.

### Afterwards

- `SELECT version();` — the script prints it, but check it.
- Run a real exam end to end.
- **Check the monitoring stack**, if it is installed. A collector that trips
  over a renamed system view leaves panels blank rather than firing an alert,
  so this is the failure mode most likely to go unnoticed.
  `postgres-exporter` handles the `pg_stat_bgwriter` → `pg_stat_checkpointer`
  split introduced in 17, but confirm rather than assume. Open the SSH tunnel
  from "Reaching the dashboards" above, then:
  - Prometheus (http://localhost:9090) → Status → Targets: `postgres-exporter`
    and `redis-exporter` both UP, with no scrape errors.
  - Grafana (http://localhost:3001) → "OpenExam Overview": no empty panels.
- Confirm the base backup landed:
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
    exec -T postgres wal-g backup-list
  ```

### Incompatibilities that break automation

Small individually, and all in the same place — scripts and cron lines that
have worked for years:

- **MD5 passwords are deprecated.** `CREATE ROLE`/`ALTER ROLE` now warn when
  setting one; `md5_password_warnings = off` silences it. This stack uses
  `scram-sha-256`, so it should not come up — but the `monitoring` and
  `glitchtip` roles are created by scripts, so check their output.
- **`COPY FROM` end-of-file handling** changed.
- **Timezone abbreviation handling** changed.
- **`VACUUM`/`ANALYZE` inheritance behaviour** changed for partitioned and
  inherited tables.

### Rolling back

`scripts/rollback.sh` does not touch the database engine, by design, and it
cannot help here. The only path is: restore the pre-upgrade dump into a
`postgres:16` container, point `infra/postgres/Dockerfile` back at the 16
digest, and rebuild. Expect to lose everything written since the dump.

## Redis 7 → Valkey migration

One-time. The `redis` service now runs Valkey on a **new** `valkey_data`
volume; the Redis 7 data in `redis_data` has to be carried over first, and
`scripts/deploy.sh` refuses to run until it has been (it would otherwise start
Valkey on an empty volume and drop the Cap site key registration with it).

Why it isn't an image swap: Redis 7.4 writes RDB v12 and Valkey refuses it by
default (`Can't handle RDB format version 12`) — #202 tried exactly that and
the app tier never came back. Valkey's `--rdb-version-check relaxed`
loads it as long as the file holds no encoding Valkey doesn't know, so
`scripts/valkey-migrate.sh` loads a *copy* once in relaxed mode, rewrites the
AOF in Valkey's own format, and proves a normal (strict) start reads it back.

1. **Rehearse** — no downtime; copies the live volume read-only into a
   throwaway one and runs every step there:

   ```bash
   ./scripts/valkey-migrate.sh --rehearse
   ```

   It prints keys per database/prefix before and after, and must end in
   `PASS`. Key counts move a little between the snapshot and the copy (TTLs,
   rate-limit keys) — that's expected; a missing `cap:key:<site key>` or a
   load error is not. On `FAIL`, stop here and keep the output.
2. **Cut over** — outside exam hours; downtime is the drain plus a few
   seconds of copying:

   ```bash
   ./scripts/valkey-migrate.sh --yes-i-am-sure
   ```

   It stops nginx, web and GlitchTip, waits for ws-backend to drain
   `ws:dirtyexams` into Postgres, stops the rest of the Redis clients and
   Redis itself, migrates into `valkey_data`, recreates **only** `redis` on
   Valkey, and restarts every other stopped service as the same container it
   was — the app tier is not upgraded here. Any failure before `redis` is
   recreated restarts the untouched Redis 7 containers, so the stack comes
   back as it was.
3. **Deploy:** `./scripts/deploy.sh`. Its guard now passes (`valkey_data`
   exists), and it rolls the app tier forward to the checked-out commit as
   an ordinary deploy, separate from the Redis change.
4. **Check:** the deploy prints no Cap site key note; sign-in (with
   captcha) works; an answer saved in a demo exam lands in Postgres;
   Grafana's Redis panels have data.

**Rolling back afterwards:** set the `redis` service back to the previous
`redis:7-alpine` digest, `redis-server`/`redis-cli`, and `redis_data:/data`,
then `docker compose … up -d redis`. `redis_data` was never written to, so
this works — but it loses whatever was written while on Valkey. Once Valkey
has run through a real exam, drop `redis_data` from the compose file and
`docker volume rm openexam-prod_redis_data`.

## Encrypted SFTP backups (opt-in)

Set `WALG_STORAGE_BACKEND=disabled` to keep SFTP backups off (the default).
Deploy after changing this option: PostgreSQL must restart to change
`archive_mode`. Disabled deployments run no tunnel and make no SFTP connection.
The old MinIO data volume is preserved, but MinIO is no longer a service.
`WALG_STORAGE_BACKEND=sftp` selects `docker-compose.sftp.yml` in the deploy,
backup, and restore scripts. A bare `docker compose` command does not load
this overlay: use both `-f docker-compose.prod.yml -f docker-compose.sftp.yml`
when operating the SFTP deployment manually.

1. Verify the backup host's ED25519 fingerprint through its provider console.
   Save the verified host-key line in `secrets/walg_known_hosts`. Scanning a
   key with `ssh-keyscan` alone does not verify the server's identity.
2. Run `./scripts/setup-walg-sftp.sh HOST walg /archive`. It builds the
   Dockerfile's `walg-setup` stage and runs the generator there, so the host
   needs Docker only (no Node or `node_modules`). Download and
   keep the recovery PDF off-host, then acknowledge it using the code printed
   on the sheet. The acknowledgement records the key fingerprint; it cannot
   prove where the operator stored the copy. This script leaves live backups
   unchanged. It hands the encryption and SSH keys to uid 999 (step 4) and
   the PDF to you, so `scp` can fetch it.
3. On the backup host, create a dedicated `walg` account and root-owned
   chroot `/srv/openexam-backups`, with a writable `archive` directory owned
   by `walg`. Install the generated public key in its `authorized_keys` using
   (replace `22` with `WALG_SSH_PORT` if sshd listens elsewhere; the tunnel
   forwards to the backup host's own sshd on that port):

   ```text
   restrict,port-forwarding,permitopen="127.0.0.1:22" ssh-ed25519 PUBLIC_KEY openexam-walg
   ```

   Set the account's home and `.ssh` directory ownership to `walg`, with
   directory mode 0700 and `authorized_keys` mode 0600. SSH reads that file
   as the account user; a root-owned file with mode 0600 is unreadable.

   Add a `Match User walg` sshd configuration with `ChrootDirectory
   /srv/openexam-backups`, `ForceCommand internal-sftp -d /archive`,
   `PasswordAuthentication no`, `AllowTcpForwarding local`,
   `PermitOpen 127.0.0.1:22` (the same port as above), `PermitTTY no`, and
   `X11Forwarding no`.
   Validate with `sshd -t` before reloading SSH. Keep the administrator's
   session open during this change.
4. Set ownership of the three local secret files to uid 999 and mode 0600
   (the Postgres and tunnel containers use this uid). The deploy user then
   cannot read them; the scripts validate them in a throwaway container
   instead (`require_walg_secrets` in `scripts/lib/production-compose.sh`):

   ```bash
   chown 999:999 secrets/walg_ssh_key secrets/walg_libsodium_key secrets/walg_known_hosts
   chmod 600 secrets/walg_ssh_key secrets/walg_libsodium_key secrets/walg_known_hosts
   ```

5. Set `WALG_SSH_HOST`, `WALG_SSH_PORT`, `WALG_SSH_USER=walg`, and
   `WALG_SSH_PATH=/archive` in `.env.prod`. Test the tunnel, encrypted writes,
   and reads in an isolated container before changing `WALG_STORAGE_BACKEND`
   to `sftp`. Deploy outside exam hours; the changed Postgres environment
   requires a restart. Immediately take a full backup with
   `scripts/pitr-backup.sh`.
6. Fetch the new backup into a scratch database and replay archived WAL.
   Use the recovery-sheet copy of the key for this drill. Only after the
   restored rows and uploaded files have been checked should you rely on SFTP
   for recovery. Keep historical MinIO volumes; using those archives requires
   the previous MinIO configuration. Setting `disabled` stops new archives.

### Recovering on a rebuilt host

The recovery sheet holds the encryption key; the SSH credential is replaced.

1. `./scripts/restore-walg-key.sh` and type the key from the sheet. It writes
   `secrets/walg_libsodium_key` (uid 999, mode 0600) and records the sheet as
   acknowledged (`secrets/.walg_key_saved`), which every SFTP deploy, backup
   and restore requires.
2. `./scripts/setup-walg-sftp.sh HOST walg /archive` creates a new SSH key. The
   key is already acknowledged, so no new PDF is produced. Install its public
   key on the backup host (step 3 above) and pin the host key (step 1).
3. Set the `WALG_*` values in `.env.prod`, then run `./scripts/pitr-restore.sh --latest --yes-i-am-sure`
   (it starts the tunnel itself and checks the archive before wiping).

### Behavior when the backup host is unreachable

Postgres does not wait for the tunnel: it starts even if the backup host is
down or its host key changed. `archive_command` then fails and Postgres
retries, keeping unarchived WAL in `pg_wal` (watch disk space); the nightly
`pitr-backup.sh` fails and `WalGBackupStale` fires after 25 h. Check
`docker compose ... ps walg-sftp` (its healthcheck needs an SSH banner from
the far end of the forward) and `logs walg-sftp`.

### Security notes

wal-g v3.0.7 ignores SSH host keys. The `walg-sftp` container therefore wraps
its SFTP connection in an OpenSSH tunnel with strict host-key verification.
The tunnel has no published port, runs as uid 999, and grants the remote
account forwarding only to the backup host's own SSH listener. Backup data
is encrypted with a 32-byte libsodium key using the explicit `hex` transform.
The host's root password is used only for initial provisioning; it is never
part of the application's configuration.

## Things to know

- **`NEXT_PUBLIC_BASE_URL` is baked into the web image** at build time
  (client bundle). Changing the domain requires editing `.env.prod` _and_
  rebuilding (`deploy.sh` does both).
- **`OPENEXAM_DOMAIN` is mandatory** (`.env.prod`): nginx renders it into
  `server_name` and refuses every other Host header with 444, and the
  container refuses to start without it. Keep it equal to `DOMAIN`/
  `NEXT_PUBLIC_BASE_URL`'s host.
- **Required secrets the web tier now enforces at boot**: `BETTER_AUTH_URL`
  (pinned origin for auth emails — host-header poisoning defense),
  `AT_REST_ENC_KEY` (≥32 chars, AES-256-GCM at-rest key), and ≥32-char
  `BETTER_AUTH_SECRET`/`MATCHING_ID_SECRET`, ≥12-char `TEACHER_ACCESS_CODE`,
  ≥16-char `CAP_ADMIN_KEY`/`CAP_SECRET_KEY` (Cap dashboard + server-side
  captcha verification).
  Placeholder values (`change-me`) are refused in production.
- **Microsoft login is optional**: leave `MICROSOFT_CLIENT_ID`/
  `MICROSOFT_CLIENT_SECRET`/`MICROSOFT_TENANT_ID` all empty and prod boots
  without it. Setting any of them opts in — and then `MICROSOFT_TENANT_ID`
  must be the school's Entra tenant GUID (not `common`/`organizations`/
  `consumers`, which accept any tenant's tokens and would enable email-domain
  role escalation to TEACHER). Enforced in both lib/env.ts and lib/auth.ts —
  since Better Auth 1.7 in *every* environment, not just production: the
  upstream `microsoftEntraId` helper itself rejects a non-GUID tenant.
  The Entra redirect URI is `https://<host>/api/auth/callback/microsoft-entra-id`.
- **`NEXT_PUBLIC_CAP_WIDGET_ENDPOINT` is baked into the web image** at build
  time (the Cap widget's `data-cap-api-endpoint`, site key included — it's
  public, unlike `CAP_SECRET_KEY`). To create or rotate the site key, run
  `scripts/create-cap-site-key.sh` (creates it in cap via the admin API and
  updates `.env.prod`) and redeploy; the old endpoint keeps working in
  browsers until rebuilt. An empty value breaks every captcha gate
  (sign-up and sign-in): the widget throws "Missing API
  endpoint". `scripts/deploy.sh` warns when the baked site key isn't
  registered in cap yet.
- **Upgrading an existing install**: after deploying the at-rest encryption
  change, run `pnpm tsx scripts/encrypt-at-rest.ts` against the database to
  re-wrap legacy plaintext OAuth tokens and SEB quit passwords (idempotent).
- **SEB WebSocket handshake changed**: SEB tokens no longer travel as
  `?sebKey=/&bekKey=` query parameters but as the socket's first message.
  The web and ws-backend images must be deployed **together** — an old
  client bundle against the new ws-backend (or vice versa) cannot pass the
  SEB handshake.
- **ws-backend reads `NEXT_PUBLIC_BASE_URL`** (legacy `APP_BASE_URL` kept as
  a fallback) — the compose file derives everything from the same variable;
  don't override one independently, or SEB Config Key verification breaks
  silently.
- **`NEXT_PUBLIC_WS_URL` stays unset in prod** — browsers fall back to the
  page origin and nginx proxies `/ws/` same-origin.
- **The exam start is queued, not first-come-first-served.** New joins are
  admitted at `EXAM_ADMISSION_RATE_PER_SEC` (default 25/s) and nobody waits
  longer than `EXAM_ADMISSION_MAX_WAIT_SEC` (default 45 s); held students see
  a countdown on the join form and their exam clock starts on admission, not
  on the button press. Resumes skip the queue, and so does the first second's
  worth of any cohort — a class of 25 at the default rate never sees it at
  all; it exists for the case where a whole year group starts at the same
  bell. Redis backs it and fails open, so an outage degrades to the old
  unthrottled behaviour rather than locking a class out. Set the cap to `0`
  to turn it off.
- **`/` is micro-cached at nginx for 30 s** (`location = /` in
  `nginx/nginx.conf`). Only the logged-out render is shared: any request
  carrying a Better Auth session cookie bypasses the cache and is never
  stored in it, and nginx refuses to cache a response that sets a cookie.
  Two consequences worth knowing: a deploy's new landing page can take up to
  30 s to appear, and the cache survives `nginx -s reload` (so
  `scripts/deploy.sh` does not clear it) — restart the nginx container if you
  need it gone immediately. It applies to the landing page only; `/login` and
  `/register` are deliberately excluded because they carry per-render CAPTCHA
  state.
- **Secrets** live in `.env.prod` (chmod 600, gitignored). This deviates from
  PRD §12.3 "Docker secrets" deliberately: no component in the stack reads
  `*_FILE` variants, and on a single host the isolation gain is nil.
- **Backups**: `scripts/backup.sh` gives daily-RPO `pg_dump` archives in
  `./backups/`; copy them offsite (e.g. `rclone` to object storage). For the
  PRD's <1h PITR target, see "Point-in-time recovery" above (WAL archiving
  via wal-g — an addition on top of, not a replacement for, these
  `pg_dump` archives). Uploaded exam files live in Postgres (`AnswerFile`),
  so these dumps and wal-g already include them.
- **Restore**: `docker compose ... exec -T postgres pg_restore -U openexam
  -d openexam --clean --if-exists < backups/<file>.dump` for a `pg_dump`
  archive: `scripts/pitr-restore.sh` to restore the latest base backup
  (historical point-in-time targets are currently refused; requires the
  monitoring stack; see above).
- **`postgres`'s image is now built locally**, not a bare pinned upstream
  image (`infra/postgres/Dockerfile`, adds the `wal-g` binary for PITR
  above). Security patches now arrive via Dependabot bumping that
  Dockerfile's `FROM` line, rather than a bare digest bump in
  `docker-compose.prod.yml` — same mechanism, one layer removed.
- **Scaling**: web replica count is `deploy.replicas` in
  `docker-compose.prod.yml` (plain Compose honors it; no swarm needed).
  Postgres scales vertically first (PRD §15.3). After scaling, reload nginx
  (`scripts/deploy.sh` already does this) — it resolves the `web` upstream
  once at config load, so a stale replica count otherwise routes to
  addresses that no longer exist.
- **Autovacuum on `Answer` / `ExamSession`**: these tables see heavy UPDATE
  churn from autosave, and under sustained load the default autovacuum
  thresholds fall behind — measured at ~4× p95 latency until vacuumed.
  A migration tightens the per-table scale factors
  for new deployments; **existing installs upgrading past that migration
  need one manual `VACUUM (ANALYZE);`** to reclaim already-accumulated bloat
  before the tighter settings take effect on the next natural trigger.
- **Logs**: `docker compose -f docker-compose.prod.yml --env-file .env.prod
  logs -f <service>`. `web` logs structured JSON (`lib/logger.ts`, pino) and
  `ws-backend` logs structured JSON (`log/slog`) — both greppable/`jq`-able.
  Failed audit-log writes (`lib/audit.ts`) are logged this way **and**
  reported to GlitchTip individually if the monitoring stack is deployed.
- **Clocks must agree across hosts.** `ws-backend` stamps each answer save
  with its own receive time and compares it with the lock intervals Postgres
  records with its clock (`SessionLockInterval`). On the single-host compose
  stack both read the same clock. If the WebSocket backend and Postgres ever
  run on different hosts, run NTP (chrony/systemd-timesyncd) on all of them:
  clock skew silently widens or narrows lock intervals, accepting saves made
  while locked or rejecting saves made just after an unlock.

## Disaster recovery

### What's actually the single point of failure

Every service in `docker-compose.prod.yml` runs on one host (PRD §16 chose
single-server deliberately: this is a self-hosted tool for one school, not a
multi-tenant SaaS). Component *crashes* inside that host are already handled
without operator intervention:

| Failure | What happens |
|---|---|
| One `web` replica OOMs/crashes | `restart: unless-stopped` respawns it; nginx's upstream still has the other replicas — a request that lands on the dead one just fails once and the client's fetch/WS layer retries |
| `ws-backend` crashes or restarts | Client reconnects with exponential backoff (1s→30s, see "Real-time delivery & data safety" in README); meanwhile each save falls back to REST (`PUT /api/sessions/{id}/answers`) and anything unsent stays buffered in LocalStorage |
| Valkey (`redis` service) restarts | AOF (`--appendfsync everysec`) replays on startup — at most ~1 s of in-flight answers lost, and those are also sitting in the client's LocalStorage buffer until a save is acknowledged |
| Postgres restarts (OOM, `docker compose restart`, host reboot) | Data survives on the `postgres_data` volume; `web`/`ws-backend` reconnect automatically via the pg pool |
| Network blip between student and server | Covered by the client's save path — LocalStorage buffering, per-save REST fallback, WS reconnect, and a 30 s server-side grace window after the deadline for late saves/submits |

**The one failure none of that covers is the host itself dying** — disk
failure, the VM's underlying hardware failing, an accidental `rm -rf`, a
botched `docker compose down -v`. Every stateful volume (`postgres_data`,
`valkey_data`) and the `./certs` bind mount live on that one
disk, and `scripts/backup.sh` (as configured today) writes dumps to
`./backups/` on that *same* disk — so out of the box, losing the host loses
the backups with it. That's the actual SPOF, and closing it is two things:
get backups off the host, and have a runbook to rebuild without one.

### Get backups off the host

`scripts/backup.sh` already runs `pg_dump` daily via cron ("First-time
server setup" above). `./openexam backup-offsite` (also offered by
`./openexam install`) adds the offsite copy:

- Targets: S3-compatible storage, Backblaze B2, SFTP (e.g. Hetzner Storage
  Box, port 23) or a directory on the host (a mounted NAS).
- Encrypted client-side by default with an rclone `crypt` remote. The
  passphrase is generated and shown **once** — store it in a password
  manager; this server only keeps it (obscured) in `.rclone.conf`, which
  dies with the server.
- What is shipped: the dumps **and `.env.prod`** — a rebuild needs both.
- rclone runs from a pinned `rclone/rclone` image (`scripts/offsite.sh`),
  nothing is installed on the host. Credentials live in `.rclone.conf`
  (chmod 600, gitignored).
- Cron, installed by `scripts/install-cron.sh` once `.rclone.conf` exists:

  ```cron
  0 3 * * *  /opt/openexam/scripts/backup.sh >> /var/log/openexam-backup.log 2>&1
  15 3 * * * /opt/openexam/scripts/offsite.sh push >> /var/log/openexam-offsite.log 2>&1
  ```

  `push` skips dumps younger than an hour (`--min-age 1h`, so it never
  ships one still being written) and deletes remote dumps older than
  `OFFSITE_RETENTION_DAYS` (default 30).
- `./openexam backup` takes a dump and pushes it right away;
  `./openexam restore --from-offsite` restores one.

This turns "disk dies" from *total data loss* into *up to 24 h of data
loss* (daily-RPO `pg_dump`, per the existing caveat above).

Two gaps beyond that, in priority order:

1. **WAL archiving** (wal-g or pgBackRest) for the PRD's <1 h PITR target —
   already flagged as an open follow-up above. Without it, RPO is bounded by
   how often `backup.sh` runs, not by anything tighter.
2. **Offsite archives** are optional: configure encrypted SFTP backups to
   keep WAL off-host. With PITR disabled, recovery uses daily dumps. Uploaded
   files are in Postgres and are included in database backups.
   (The wal-g SFTP archive, `WALG_STORAGE_BACKEND=sftp`, and the
   `./openexam backup-offsite` copies of the daily dumps above are
   independent: the first is for point-in-time recovery, the second for
   rebuilding from a dump plus `.env.prod`. Either, both or neither.)

### Rebuild-from-scratch runbook

If the host is gone, this is "First-time server setup" (above) plus a
restore step, so the runbook is: keep that section current, and practice
this at least once before relying on it.

With offsite backups set up by `./openexam backup-offsite`, the new box only
needs the target's credentials and the encryption passphrase:

```bash
git clone <repo> /opt/openexam && cd /opt/openexam
./openexam install --restore
```

It fetches `.env.prod` from the offsite copy **before** anything is
generated (so no secret is regenerated), lets you pick a dump, starts the
stateful services, restores the dump in a single transaction, deploys, and
re-registers the captcha site key — that registration lives in Valkey, not
in the dump, so a new one is created and baked in when the old one is gone.
Then point DNS at the new box; the wizard issues the certificate once it
resolves (or later: `./scripts/issue-cert.sh`).

The same by hand:

```bash
# 1. New box: repeat "First-time server setup" steps 1-2 (DNS, one-command
#    setup) with an existing .env.prod — restore .env.prod from your offsite
#    copy instead of regenerating secrets — regenerating
#    BETTER_AUTH_SECRET/AT_REST_ENC_KEY/etc. makes
#    every existing session and encrypted-at-rest value unrecoverable.
# 2. Bring up just the stateful services
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres redis cap

# 3. Pull the latest dump from the offsite remote (not the dead host) and restore
rclone copy remote:openexam-backups/openexam-<latest>.dump ./backups/
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_restore -U openexam -d openexam --clean --if-exists < backups/openexam-<latest>.dump

# (Uploaded exam files are inside the dump — no separate restore step.)

# 4. Resume "First-time server setup" from step 3 onward (optional
#    SMTP_*/Microsoft values; the one-command setup-prod.sh already covered
#    TLS, cron and firewall in step 2). The Cap site key registration lived
#    in the old host's Valkey, so check it: create-cap-site-key.sh is a no-op
#    when the key is registered and creates (and writes) a new one when not —
#    redeploy after it changed anything.
./scripts/deploy.sh
./scripts/create-cap-site-key.sh && ./scripts/deploy.sh
```

`.env.prod` living only on the dead host (gitignored, chmod 600, by design)
is itself a single point of failure for *the recovery process* — keep an
encrypted copy of it in the same offsite location as the DB dumps, not just
on the server.

### How likely is a mid-exam failure, really?

Two different risks get conflated here — worth separating:

- **A component crashing mid-exam** (a `web` replica OOMing, `ws-backend`
  restarting, a network blip) — not rare, and explicitly designed for: the
  offline recovery flow, 4 web replicas, and Redis AOF exist *because* this
  happens. A student sees "Connection lost — your answers are saved
  locally" for a few seconds and nothing is lost. This is a handled case,
  not a risk being accepted.
- **The host itself failing mid-exam** (hardware fault, disk failure,
  provider-side outage) — this is the genuine SPOF. It's rare in absolute
  terms but not zero: a well-run cloud VM typically sees on the order of a
  few hours of unplanned downtime a year (roughly what a "three nines" SLA
  implies — treat this as an order-of-magnitude estimate, not a guarantee
  for any specific provider). A typical exam session runs 1-2 hours. The
  chance a *given* exam window happens to overlap with one of those rare
  failures is roughly `(exam duration) / (year) × (expected failures/year)`
  — for a 90 min exam against ~1 unplanned outage/year, that lands around
  1-in-5,000 to 1-in-10,000 per exam. Low, but "low and irrecoverable" is a
  materially worse combination than "low and recoverable in minutes with
  offsite backups" — that gap, not the raw probability, is the actual case
  for doing the offsite-backup work above rather than treating the current
  single-server design as sufficient on its own.

In short: crashes and network blips during an exam are already a solved
problem in this codebase. The host dying mid-exam is unlikely but not
negligible, and today it's also unrecoverable (backups die with the host) —
closing that combination is what this section is for.

## Local rehearsal (no real domain)

```bash
cp .env.example .env.prod          # set NEXT_PUBLIC_BASE_URL=https://localhost etc.
mkdir -p certs/live/openexam
openssl req -x509 -nodes -newkey rsa:2048 -days 3 \
  -keyout certs/live/openexam/privkey.pem \
  -out certs/live/openexam/fullchain.pem -subj "/CN=localhost"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
curl -k https://localhost/api/health   # → {"ok":true}
```

File uploads are stored in Postgres and can be tested locally.

To also rehearse the monitoring stack locally, fill in the monitoring
section of `.env.prod` (real, non-placeholder values — `setup-monitoring.sh`
refuses placeholders) and run `./scripts/setup-monitoring.sh` after the
above. Since this is all on one machine already, the SSH-tunnel commands
aren't needed — just open `http://localhost:9090`, `:9093`, `:3001`, `:8001`
directly.

### Server-side deadline recovery

The persistent Node server runs a deadline recovery sweep every 30 seconds in
production. `DEADLINE_SWEEPER_ENABLED=false` disables it. Apply migrations before
starting the new web and WebSocket images.

Sessions still `IN_PROGRESS` or `LOCKED` five minutes after their
`effectiveEndTime` are atomically marked `AUTO_SUBMITTED` / `AUTO_TIME`, including
per-student extensions and NAM. This delay does not extend the REST/WebSocket
answer-writing grace. Each sweep selects at most 25 sessions; a large backlog or
slow finalization delays later batches further.

A Redis lease reduces duplicate work across replicas; the live database status
and deadline predicates decide which replica claims a session. A durable
`deadlineFinalizationPending` marker retries post-claim finalization if a process
stops; closing an exam sets the same marker on the sessions it force-submits, so
a crash during a close is finished by the sweeper (after the same five-minute
grace). Delivery is at least once, but a re-run is duplicate-safe: grading is
idempotent, audit rows carry a unique `idempotencyKey`, and a control message
already published is not re-sent (a `finalize:published:<key>` Redis marker,
24 h). The one remaining duplicate is a crash between publishing a control
message and writing that marker. Existing
finalization still treats Redis/audit errors as best effort and uses the grading
safety net, so monitor logs for failures. This timer requires a long-lived Node
process; it is not a scheduler for a suspended/serverless deployment.

### Attachment storage and retention

Replacement uploads stage a new attachment without deleting the saved file, so
a student never loses work to a failed or offline autosave. Superseded and
abandoned uploads are pruned later by a retention job
(`lib/answer-file-retention.ts`) that runs every 10 minutes in production
(`ANSWER_FILE_RETENTION_ENABLED=false` disables it). It deletes an
`AnswerFile` row only when its session is `SUBMITTED`/`AUTO_SUBMITTED`, has no
pending finalization, was submitted more than 15 minutes ago, has nothing left
in the WebSocket answer buffer, and no answer references the file. In-progress
and locked sessions are never touched; if Redis can't be read, the run is
skipped. Everything else still goes with its session or question (FK cascade).

**Storage ceiling.** Each session can store at most its upload budget: twice
the exam's total file-upload capacity, at least 512 MB (`lib/upload-budget.ts`;
25 MB per file). The upload route enforces it against a 48-hour Redis counter
and, durably, against the bytes the session already holds in Postgres. Plan
disk for `students × budget` per running exam in the worst case; after
submission the retention job shrinks each session to the files its answers
reference. Watch `openexam_answer_files_pruned_total` /
`openexam_answer_file_bytes_pruned_total` next to Postgres disk usage and
backup size.

**Manual cleanup** (same rules as the job; run in `psql`, check the count
first):

```sql
-- How much is reclaimable now?
SELECT count(*), pg_size_pretty(sum(f."sizeBytes")::bigint)
FROM "AnswerFile" f JOIN "ExamSession" s ON s."id" = f."sessionId"
WHERE s."status" IN ('SUBMITTED', 'AUTO_SUBMITTED')
  AND NOT s."deadlineFinalizationPending"
  AND s."submittedAt" < now() - interval '15 minutes'
  AND NOT EXISTS (SELECT 1 FROM "Answer" a
                  WHERE a."sessionId" = f."sessionId"
                    AND a."questionId" = f."questionId"
                    AND a."content"->>'fileKey' = f."key");
```

Replace the `SELECT` line with `DELETE FROM "AnswerFile" f USING "ExamSession" s`
and move the join condition (`s."id" = f."sessionId"`) into the `WHERE` to
delete. Only do this while the WebSocket backend is running normally (its
buffer flushes within seconds); otherwise rely on the job, which checks the
buffer.
