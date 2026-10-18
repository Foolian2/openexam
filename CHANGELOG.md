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

### Upgrade notes

- Apply the additive `PAGE_FOCUS_LOST` database migration before updating the web
  and WebSocket services. Deploy both services together between exams.
- Regenerate stored SEB Config Keys and download fresh `.seb` files before testing
  or starting another exam; existing clients retain their launch configuration.
- Run `scripts/setup-monitoring.sh` before starting the updated monitoring profile
  to set `ALERTMANAGER_CONFIG_GID`.
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
