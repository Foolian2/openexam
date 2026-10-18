# Load / stress tests

k6 scenarios exercising OpenExam's real hot path — Next.js REST API, the Go
`ws-backend` WebSocket sidecar, Postgres, and Redis — against the
performance targets in the root `README.md`: **1,000 concurrent exam
participants, p95 REST API latency < 200ms, p95 WS answer-save→ack latency
< 100ms**.

Not wired into CI — these are slow/heavy and would slow down every PR. Run
them locally, or manually, whenever you want a read on performance.

## Prerequisites

1. **k6** — a standalone Go binary, not an npm dependency.
   `brew install k6` (macOS) or see https://k6.io/docs/get-started/installation/
2. The app stack running locally:
   ```
   docker compose up -d          # postgres, redis, minio, ws-backend
   pnpm exec prisma migrate deploy
   pnpm build && pnpm start      # production build — see "dev vs prod" below
   ```
3. Seeded student **and teacher** accounts (see below) — required by every
   scenario; seed at least as many students as the scenario's peak VU
   count.

### Dev vs. production build

`pnpm dev` (Turbopack) works but has different overhead than a production
build. For numbers you'd actually trust against the README's targets, use
`pnpm build && pnpm start`. Use `pnpm dev` only for quick iteration on the
k6 scripts themselves. (Earlier drafts of this suite provisioned the
teacher account via Better Auth's real sign-up flow, which only
auto-verifies in dev — `pnpm load:seed` now mints the teacher directly the
same way it mints students, so this constraint no longer applies, but the
production-build path hasn't been independently re-verified since that
change landed — spot-check it before trusting numbers from it.)

## Seeding student and teacher accounts

Scenarios need many authenticated "students" (and at least one "teacher")
active at once. Provisioning them over HTTP doesn't work here — two
independent reasons:

- Better Auth rate-limits `/api/auth/sign-in/email` and `/sign-up/email` at
  5 requests/60s **per IP** (`lib/auth.ts`), and every k6 VU would be
  authenticating from the same load-generator host — so even "each VU
  signs in once" throttles the instant VU count passes ~5.
- A session created via the *real* sign-in flow lives only in Redis
  (Better Auth's `secondaryStorage` cache, configured in `lib/auth.ts`,
  with no `session.storeSessionInDatabase` override) — it's never written
  to Postgres. `ws-backend` checks Postgres and only Postgres
  (`ws-backend/internal/store/store.go`'s `LookupSession`), so a
  real-signed-in cookie authenticates REST calls fine but is invisible to
  every WS endpoint, including the teacher's `/ws/monitor/{examId}`. A k6
  WS scenario driving a connection that gets rejected at the upgrade turns
  into a tight, near-instant reconnect loop rather than a clean error —
  that's how this was actually found while building scenario 05.

So `scripts/load-seed.ts` provisions both students and a teacher by
writing sessions directly into *both* Postgres and Redis, with an
already-signed cookie value in the exact format
`ws-backend/internal/auth/auth.go` and the Next.js API each verify — no
server-side auth code path is skipped, only the client sign-up/sign-in
round-trip.

```bash
pnpm load:seed -- --count 1000 --teachers 2
```

Writes `load/data/seed-users.json` and `load/data/seed-teachers.json`
(gitignored — synthetic per-run data, not fixtures). Re-running with a
larger `--count`/`--teachers` only creates the accounts that don't exist
yet; re-run any time to grow the pool. Requires `BETTER_AUTH_SECRET` and
`DATABASE_URL` from `.env` (the script loads it automatically via
`--env-file-if-exists=.env`).

Seed at least as many students as the **peak VU count** across the
scenarios you plan to run — each scenario checks this in `setup()` and
fails fast with the exact `pnpm load:seed` command to fix it if the pool
is too small. One teacher is enough for every scenario here, but
`05-mixed-exam-room.js` reuses the same teacher identity for all
`MONITOR_VUS` connections, which is fine — ws-backend's monitor endpoint
only checks that the caller is the exam's creator, not that each
connection is a distinct person.

### DISABLE_RATE_LIMIT (optional, local-only)

Since both students and the teacher are seeded directly, none of the
scenarios in this suite call Better Auth's sign-up/sign-in endpoints
anymore, so its rate limiter is no longer a practical concern for a
normal run. It can still bite you if you're iterating on the k6 scripts
themselves and re-running `setup()` repeatedly within the same 60s window
(each run's `POST /api/sessions` join calls, and — if you add a scenario
that does call sign-up/sign-in — those too, are rate-limited). Set
`DISABLE_RATE_LIMIT=true` in your local `.env` (or export it before
starting the server) to bypass every `rateLimit()`-backed check
(`lib/rate-limit.ts`) and Better Auth's own sign-in/sign-up limiter
(`lib/auth.ts`) at once. **Never set this in a reachable deployment** —
it's read directly from `process.env` with no other guard.

### EXAM_ADMISSION_MAX_WAIT_SEC (set it to 0 to measure a raw ceiling)

`POST /api/sessions` admits first-time joiners at a fixed rate and answers
`202 { queued: true, waitMs }` to everyone else, so a class arriving at once
is spread over the following seconds instead of landing as one burst
(`lib/exam-admission.ts`). `lib/exam.js`'s `joinSession()` waits that out the
way a browser does, and reports the total hold as the `admission_wait_ms`
trend — separate from `http_req_duration`, because a queued wait is the
server working as designed, not latency.

That means a scenario measuring **arrival capacity** is, by default, measuring
the queue rather than the tier behind it: offered join load is capped at
`EXAM_ADMISSION_RATE_PER_SEC` no matter how hard you push. To find the raw
ceiling again, switch the queue off on the server for the run:

```sh
EXAM_ADMISSION_MAX_WAIT_SEC=0   # in .env, or exported before starting the server
```

Unlike `DISABLE_RATE_LIMIT` this is a supported production setting, not a
local-only escape hatch, so it is safe to leave in a benchmark environment —
but a run with the queue off is measuring the failure mode the queue exists
to prevent. Record which way it was set alongside the numbers.

### DISABLE_CAPTCHA (not needed by any scenario here)

The access-code join endpoint (`POST /api/sessions`, used by
`02-join-and-autosave.js` and `05-mixed-exam-room.js`) is not
captcha-gated — sign-up/sign-in are (via better-auth's `captcha` plugin in
`lib/auth.ts`), but join relies on rate-limiting plus the size of the
access-code space instead. `scripts/load-seed.ts` bypasses sign-up/sign-in
HTTP entirely (mints sessions directly into Postgres/Redis), so no k6
scenario here ever calls a captcha-gated endpoint. `DISABLE_CAPTCHA=true`
still exists (`e2e/toctou-fixes.spec.ts` needs it — real HTTP sign-in calls,
captcha off but rate-limiting on) but you shouldn't need it for anything
in this directory.

## Running a scenario

```bash
pnpm load:smoke        # 01-rest-smoke.js       — REST latency baseline
pnpm load:join         # 02-join-and-autosave.js — join + REST autosave loop
pnpm load:ws-connect   # 03-ws-mass-connect.js  — mass WS connect (PRD T1)
pnpm load:ws-latency   # 04-ws-answer-latency.js — WS answer:save→ack latency (headline metric)
pnpm load:mixed        # 05-mixed-exam-room.js  — composite: WS + REST fallback + teacher monitor
pnpm load:classroom    # 06-classroom-ladder.js — many parallel classes (the capacity scenario)
pnpm load:submit       # 07-mass-submit.js      — end-of-exam thundering herd
pnpm load:fanout       # 08-monitor-fanout.js   — teacher monitor snapshot + update latency
pnpm load:integrity    # 09-integrity-load.js   — A/B: cost of integrity:event DB writes
pnpm load:soak         # 10-soak.js             — 60-minute steady state, drift and leaks
```

Scenarios 06–10 model **many parallel classes** (`-e CLASSES=8
-e STUDENTS_PER_CLASS=25`) rather than one large room, because that's what a
school actually runs and it loads room count, Redis pub/sub breadth and the DB
pool instead of a single room goroutine. They need one seeded teacher per
class: `pnpm load:seed -- --count 200 --teachers 8`.

Recommended order: run `load:smoke` first to validate the harness (auth
headers, seed data, CSRF/Origin headers) cheaply before touching anything
WebSocket-related. Then `load:join`, `load:ws-connect`, `load:ws-latency`.
Run `load:mixed` last, and only at a modest VU count first (see below).

Every scenario reads `BASE_URL` (default `http://localhost:3000`) via `-e`.
`WS_URL` is derived from it unless set explicitly: an `https://` base becomes
`wss://` on the same origin, because behind nginx `/ws/` is proxied to
ws-backend rather than exposed on port 8080. Only the local dev default
(`http://localhost:3000`) falls back to `ws://localhost:8080`, where the two
servers really do listen on separate ports. So a remote run needs one flag,
not two, and can't end up half-pointed at localhost.

```bash
k6 run load/scenarios/04-ws-answer-latency.js -e ANSWER_VUS=200 -e SEND_DURATION=5m
```

Each scenario file's top comment documents its own `-e` knobs
(`CONNECT_VUS`, `ANSWER_VUS`, `MIXED_VUS`, `RAMP_TIME`, etc).

## Reading the results

k6 prints a pass/fail line per threshold at the end of a run. The one that
matters most is in `04-ws-answer-latency.js` and `05-mixed-exam-room.js`:

```text
ws_answer_ack_latency..........: p(95)=87.3ms
✓ ws_answer_ack_latency p(95)<100
```

Before trusting a green threshold, sanity-check the **sample count** for
custom metrics (visible in the full end-of-run summary) — a threshold on
zero samples trivially "passes" and tells you nothing.

k6 **cannot** measure the PRD's "<2GB ws-backend memory under 1,000
connections" assertion — that needs to be observed from the host.
Run `docker stats ws-backend` in a second terminal instead.

## Benchmarking a remote server

**Topology.** Run k6 from a *different machine* than the system under test —
ideally a different physical host on the same wired gigabit segment. A load
generator sharing CPU with the server measures contention, not capacity, and
that objection is impossible to answer after the fact.

**Generator pre-flight.** Raise the socket limits first, or the generator
becomes the bottleneck and it looks identical to a server limit in k6's
output:

```sh
ulimit -n 65536
sudo sysctl -w net.ipv4.ip_local_port_range="10240 65535" \
                net.core.somaxconn=4096 net.ipv4.tcp_tw_reuse=1
ss -s      # check mid-run: nowhere near fd or port exhaustion
```

On macOS instead: `ulimit -n 65536`, `sudo sysctl -w
net.inet.ip.portrange.first=16384 kern.ipc.somaxconn=4096`, and wrap the run
in `caffeinate -dimsu` so the machine can't sleep mid-ladder.

**NTP.** Both machines must be time-synced. `monitor_update_lag` in
`08-monitor-fanout.js` subtracts a server timestamp from a client one, so
clock offset lands directly in that metric.

**Hostname resolution on cloud images.** If `BASE_URL` uses a name resolved
via `/etc/hosts` rather than real DNS, be aware that cloud-init rewrites
`/etc/hosts` from a template **on every boot**. A single reboot silently drops
the entry, every request becomes a connection failure, and k6 reports it as
`exam create failed: 0 null` in `setup()` — which looks like an application
fault, not a name-resolution one. Make it durable before running anything
long:

```sh
echo 'manage_etc_hosts: false' | sudo tee /etc/cloud/cloud.cfg.d/99-keep-hosts.cfg
echo '<sut-ip> exam.lan' | sudo tee -a /etc/hosts
```

**Running it.** Seed on the server, then point a scenario at it from the
generator:

```sh
# on the server under test
pnpm load:seed -- --count 1800 --teachers 80

# on the generator
k6 run -e BASE_URL=https://exam.lan load/scenarios/06-classroom-ladder.js
```

## Scale note — read before running at high VU counts

Running k6 on the same laptop as `docker compose` and the Next.js server
means the load generator competes for CPU/network with the system under
test — at high VU counts this measures local resource contention as much
as the app's real scalability. `docker-compose.yml`'s Postgres/Redis use
default (untuned) settings, and Prisma's connection pool is a plausible
bottleneck well before 1,000 concurrent sessions.

Treat 1,000-VU runs as a stretch target validated opportunistically (a
beefier machine, or at minimum `pnpm build && pnpm start` rather than
`pnpm dev`). Start with 100–200 VUs, confirm thresholds hold, then scale up
by bumping `--vus`/the relevant `-e ..._VUS` flag and re-seeding more
students with `pnpm load:seed -- --count <n>`.

## Verifying results beyond k6 thresholds

k6 prints a pass/fail line per threshold — but a green threshold alone can
be misleading. Before trusting a run:

1. **Check sample counts** for custom metrics in the full end-of-run
   summary. A threshold on zero samples trivially "passes". In
   `04-ws-answer-latency.js`, `ws_answer_ack_latency` should have at least
   `ANSWER_VUS * (SEND_DURATION / SEND_INTERVAL_MS)` samples, minus
   connection overhead.
2. **Monitor ws-backend memory**: run `docker stats ws-backend` in a
   second terminal during a `load:ws-connect` or `load:mixed` run. k6
   can't measure the "<2 GB under 1,000 connections" target directly.
3. **Check for REST fallback skew** in `05-mixed-exam-room.js`: if
   `http_req_duration{name:answer_save_rest}` has no samples, the
   REST_FALLBACK_FRACTION is likely too low for the run duration.

## Real-browser stress suite (Playwright)

In addition to the k6 protocol-level suite, `e2e/stress/` contains a
Playwright-based suite that drives real Chromium browsers at moderate
concurrency (tens, not thousands — browser contexts cost ~150-300 MB each):

```bash
pnpm test:stress
```

| Spec | Scenario | What it verifies |
|---|---|---|
| `disconnect-reconnect.spec.ts` | T2 | Buffered answers + timer survive network blips |
| `auto-submit-past-grace.spec.ts` | T3 | Offline past limit + grace → AUTO_SUBMITTED |
| `live-time-extension.spec.ts` | T5 | Teacher's WS time extension reaches student timer |
| `ws-outage-rest-fallback.spec.ts` | T12 | REST autosave works with no loss when WS is down |
| `full-lifecycle-concurrent.spec.ts` | T9 | N concurrent students, no cross-bleed, correct export |

## What's not covered here

- **FILE_UPLOAD** — upload load testing is a separate
  subsystem from the DB/Redis/WS hot path these perf targets are about;
  deliberately out of scope.
- **SEB (Safe Exam Browser) flows** — every exam here is created with
  `sebRequired: false` to avoid replicating the SEB Config Key WS
  handshake crypto (`ws-backend/main.go`'s `verifySebWsAccess`) in k6.
- **True resilience/chaos scenarios** (T8, T10, T11, T13 — killing or
  restarting ws-backend/Redis containers mid-run) — these need
  orchestration beyond straight load generation and are a planned
  follow-up once this harness is in place, not part of this suite.

### Exam-start and crash regressions

- `k6 run load/scenarios/12-exam-start-rush.js`: simultaneous joins across exams.
- `k6 run load/scenarios/13-crash-integrity.js`: save and integrity-event traffic
  during an externally controlled service interruption.

Run against a disposable installation; use the seed and environment setup above.
