# Changelog

All notable changes to OpenExam are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/) from `1.0.0` on — see "Versioning," below.

## [Unreleased]

### Fixed

- Preserve queued answers through submission, reconnects, storage denial and
  WebSocket worker interruption; serialize grading and metadata saves.
- Coordinate exam joins, closing and draft deletion; start SEB timers only when
  the verified client loads the exam, and preserve waiting-room handoffs.
- Record macOS SEB page-focus loss separately from attention events and prevent
  Windows SEB task-view focus loss; keep matching and ordering controls usable.
- Deliver both email-change confirmation messages with signed callback state and
  a per-account mail budget.
- Repair unattended installs and monitoring setup. Validate restore archives
  before changing data; refuse historical restore targets pending scratch recovery.
- Harden proxy paths and upload-origin checks; refresh dependencies and image pins.
- Improve exam-start burst handling, answer-save batching and monitoring alerts.
- Admit a whole class launching SEB from one school network address; the
  launch-token check refused the 21st student.
- Size per-IP sign-in and passkey limits for a class behind one school NAT
  address (200/min, was 5/min; Microsoft sign-in was 3 per 10 s) and sign-up
  for a class registering together (40 per 10 min). Per-account limits and the
  Cap proof-of-work still bound guessing.
- Limit failed password sign-ins to 50 per 15 minutes per IP, so the higher
  per-IP sign-in limit cannot be used to try one password against many
  accounts. Correct sign-ins are not counted, so a class is not affected.
- Give the Cap site key a class-sized rate limit (600/min per IP, was Cap's
  default 30 per 5 s); `create-cap-site-key.sh` sets it on existing keys too.

### Security

- Update the edge proxy to nginx 1.30.7, fixing the HTTP/2 remote code
  execution vulnerabilities CVE-2026-123007 and CVE-2026-123633.
- Update Next.js to 16.4.5, better-auth to 1.7.17, nodemailer, sanitize-html,
  Prisma 7.10.1 and the remaining minor/patch dependencies; clear all
  production `pnpm audit` findings (Next.js, DOMPurify, nodemailer, sanitize-html).
- Build ws-backend with Go 1.27.4 (net/http HTTP/1 server crash, CVE-2026-97033)
  and pgx 5.12.0.
- Rebase the web image on node:26-alpine 2026-11-11 (Node 26.13.1, OpenSSL 3.5.9).
- Update the Cap captcha server to 3.1.17 (Bun 1.4.4 for CVE-2026-111497, a
  forged-instrumentation fix, Debian 13.7 base) and pin the dev image too.
- Refuse non-JSON bodies and bodies over 32 KB on the public Cap routes, closing
  Cap's quadratic multipart parsing (elysia, CVE-2026-56669) at the edge.

### Upgrade notes

- Apply the additive `PAGE_FOCUS_LOST` database migration before updating the web
  and WebSocket services. Deploy both services together between exams.
- Regenerate stored SEB Config Keys and download fresh `.seb` files before testing
  or starting another exam; existing clients retain their launch configuration.
- Run `scripts/setup-monitoring.sh` before starting the updated monitoring profile
  to set `ALERTMANAGER_CONFIG_GID`.
- After deploying, run `scripts/create-cap-site-key.sh` once: it keeps the
  existing site key and gives it the class-sized Cap rate limit. Then recreate
  nginx (`up -d --force-recreate --no-deps nginx`) so the new Cap request
  checks load; `deploy.sh`'s reload keeps the previously rendered config.
- Node 26 and pnpm 12.3.4 are required. The WebSocket module requires Go 1.26;
  its production image and CI use Go 1.27.2.


## [1.0.0] - 2026-10-13

First public release. See [`README.md`](README.md) for the feature set and
[`DEPLOYMENT.md`](DEPLOYMENT.md) for installation.

## Versioning

Releases are tagged `vMAJOR.MINOR.PATCH` in git, and `package.json`'s `version` matches the latest
release.

- New entries go under **[Unreleased]** above, grouped by `Added` / `Changed` / `Fixed` /
  `Removed` / `Security` (per Keep a Changelog).
- On release, rename that section to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty
  `## [Unreleased]`, bump `package.json`, and tag the merge commit.
- Breaking operator-facing changes (a required migration step, a removed env var) bump MAJOR;
  new features bump MINOR; fixes bump PATCH.
- Entries should describe user/operator-visible impact, not restate the commit message —
  "Added X so Y is now possible," not "refactored X."

[Unreleased]: https://github.com/Foolian2/openexam/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Foolian2/openexam/releases/tag/v1.0.0
