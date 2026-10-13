# Changelog

All notable changes to OpenExam are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/) from `1.0.0` on — see "Versioning," below.

## [Unreleased]

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
