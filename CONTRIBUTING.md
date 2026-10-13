# Contributing to OpenExam

Thanks for considering a contribution. OpenExam is a Maturitätsarbeit project under active
development — the codebase is opinionated and heavily commented; read a file's existing comments
before changing behavior near them, since many encode a specific bug or security fix.

## Before you start

- For anything beyond a small fix, open an issue first (or comment on an existing one) describing
  what you want to change and why, so effort isn't wasted on something that's out of scope or
  already in progress.
- Check the product spec for the PRD's explicit non-goals (no AI proctoring, no mobile apps, no
  multi-school SaaS) before proposing a feature that might fall outside them — the spec lives in
  the private `openexam/` workspace (gitignored in this repo); ask a maintainer for access.
- Security issues: **do not** open a public issue — see [`SECURITY.md`](SECURITY.md).

## Development setup

```bash
git clone https://github.com/Foolian2/openexam.git && cd openexam
pnpm install
cp .env.example .env        # local dev values are fine as-is for most of these
docker compose up -d postgres redis cap   # dev dependencies
pnpm exec prisma migrate dev
pnpm dev
```

See the README's [Quick start](README.md#quick-start-local-development) section for the full
walkthrough, including SEB-related setup that isn't needed for most changes.

If you have a dev stack from before the Postgres 18 / Valkey 9 bump, its `postgres_data`
volume still holds a Postgres 16 cluster and the new image will refuse to start against it.
Dev data is disposable, so reset rather than upgrading it:
`docker compose down -v && docker compose up -d postgres redis cap`, then
re-run `pnpm exec prisma migrate dev`. (Production is a different matter entirely — see
`DEPLOYMENT.md`'s "Major Postgres version upgrade".)

- **Node 26**, **pnpm 12.3.4** (pinned via `packageManager` in `package.json` — use `corepack
  enable` or match the version manually).
- **Go 1.25** for `ws-backend/` (only needed if you're touching the WebSocket server).

## Before opening a PR

Run what CI runs, locally, first — a red CI run on a draft is wasted round-trip time:

```bash
pnpm lint
pnpm typecheck
pnpm test:coverage     # vitest — unit, hook and component tests + coverage thresholds (what CI runs)
pnpm test:e2e           # playwright — needs the dev stack running (docker compose up -d)
```

For `ws-backend/` changes:

```bash
cd ws-backend
go build ./... && go vet ./... && go test ./...
gofmt -l .              # should print nothing
```

`pnpm format` (prettier) before committing if you touched `.ts`/`.tsx` files — CI does not
auto-fix formatting, it only checks it.

### Adding tests

- New API routes or business logic → a unit test in `__tests__/` (Vitest). Look at an existing
  test for the area you're touching before writing a new one; the project has strong conventions
  per subsystem (e.g. `__tests__/seb*.test.ts` for SEB-related logic).
- Hooks (`hooks/`) and components → a Vitest test with React Testing Library. Suites run in
  Node by default; start a hook or component test with `// @vitest-environment happy-dom` (the
  jest-dom matchers and RTL cleanup are then set up by `__tests__/setup/dom.ts`). Component tests
  live in `__tests__/components/*.test.tsx`; query by role/label, as a user or screen reader would.
- Socket hooks → drive them with `__tests__/helpers/fake-websocket.ts`
  (`vi.stubGlobal("WebSocket", FakeWebSocket)`) and fake timers; see
  `__tests__/use-exam-socket.test.ts` for reconnect/backoff and ack-timeout patterns.
- `pnpm test:coverage` enforces thresholds per area (`vitest.config.ts`): `lib/**` and `hooks/**`
  each have their own bar, and the security-critical `lib/seb-config.ts`, `lib/seb-key.ts`,
  `lib/seb-guard.ts` and `hooks/use-exam-socket.ts` are held to ~95% individually. The combined
  and `components/**` floors are a ratchet — raise them when your tests lift the numbers.
- New user-facing flows → consider a Playwright spec in `e2e/`.
- Don't add a test that merely restates the implementation — see "What makes a good test" in
  code review culture generally; assert on behavior/output, not on internal call sequences.

## Code patterns

Most of what you'll add already has an established shape to follow — copy the nearest existing
example rather than starting from scratch.

### Adding a new API endpoint

1. Define the Zod input schema in `lib/validators/`.
2. Create the route handler under `app/api/`.
3. Check auth and role in the handler with `requireSession` / `requireStaff` / `requireAdmin` /
   `requireStudent` (`lib/api-auth.ts`), and verify ownership of the exam/session. `proxy.ts` only
   gates the session cookie; role checks must happen in the Node-runtime route.
4. Use Prisma — transactions for multi-row writes, `upsert` against the `@@unique` constraints.
5. Return errors via `lib/api-response.ts` (`{ error: { code, message } }`, correct HTTP status).
6. Record significant actions with `createAuditLog` (`lib/audit.ts`; actions in
   `lib/audit-actions.ts`).
7. Add a test in `__tests__/`.

### Adding a new question type

1. Add it to the `QuestionType` enum in `prisma/schema.prisma` and create a migration.
2. Define config + answer interfaces in `lib/types/` and Zod schemas in `lib/validators/`.
3. Mirror the answer validation in `ws-backend/internal/hub/answer_validation.go` and add vectors to
   `testdata/answer-vectors.json`, which pins the TypeScript and Go validators together.
4. Extend `sanitizeQuestionConfig` in `lib/exam-session.ts` so the solution never reaches students.
5. Add the editor (`components/questions/editor/`), viewer (`components/questions/viewer/`), and
   PDF rendering (`lib/pdf/`).
6. Add auto-grading in `lib/grading/auto-grade.ts` if the type is objectively gradable.

### Conventions

- `cuid()` primary keys; Zod on every API input; server-side validation always.
- Uploaded files go to Postgres (`AnswerFile`) and are served as forced downloads — never to
  local disk.
- Server instances are stateless — no in-memory state that must survive a request.
- German UI labels, English code and comments.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) style, observable
in `git log`: `type(scope): summary`, imperative mood, explaining *why* over *what* where it
isn't obvious from the diff.

```
fix(seb): guard activate and PATCH writes against racing config-key freezes
feat(ops): add self-hosted monitoring, alerting, PITR, and log rotation
build(deps): bump shadcn from 4.16.2 to 4.17.0
refactor(exams): lift question state into ExamEditor
chore: gitignore all of load/results/, not just the raw/ subfolder
```

Common types: `feat`, `fix`, `refactor`, `build`, `ci`, `chore`, `style`, `docs`, `test`.

## Branches and PRs

- Branch names follow `<type>/<short-description>`, e.g. `fix/cap-endpoint-build-arg`,
  `feat/student-mobile-ui`.
- Fill out the PR template — it exists so reviewers don't have to reconstruct your test plan from
  the diff.
- Keep PRs scoped to one concern where practical. Several merged PRs in this repo's history bundle
  an unrelated refactor into a fix's branch — it happens, but it's not the goal; a reviewer
  shouldn't have to review two unrelated changes to approve one.
- CI must be green (lint, typecheck, unit tests, e2e, security scans — see
  `.github/workflows/ci.yml` and `security.yml`) before merge.

## Security-sensitive areas

Some subsystems carry a higher review bar because a subtle bug there is a security bug, not just
a functional one — expect closer scrutiny (and should apply it to yourself before requesting
review) on changes to:

- `lib/auth.ts`, `lib/csrf.ts`, `lib/rate-limit.ts`, `lib/session-revocation.ts`
- `lib/seb-guard.ts` and `ws-backend`'s SEB handshake code (`ws-backend/main.go`)
- `lib/at-rest-encryption.ts`, `lib/encrypted-prisma-adapter.ts`
- Anything touching file key generation/validation (`lib/answer-file-key.ts`, `lib/answer-files.ts`, upload/download routes) — file keys are
  user-influenced and must stay scoped to the caller's own session/question.

When in doubt, add a test that exercises the failure mode you're worried about, not just the
happy path.

## License and CLA

OpenExam is licensed under the [AGPL-3.0](LICENSE). Before your first pull request can be merged,
you sign the [Contributor License Agreement](CLA.md) once: the CLA check comments on your PR, and
you sign by replying with the sentence it asks for. You keep the copyright in your work; the CLA
lets the maintainer also offer OpenExam under other licenses (for example a commercial one), and
section 4 commits to keeping your released contributions available under the AGPL-3.0 or another
open-source license. Your signature covers all later pull requests too.
