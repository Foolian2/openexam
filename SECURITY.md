# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than opening a
public issue. Open a GitHub Security Advisory (Security tab → "Report a
vulnerability") or contact a maintainer directly.

## Threat model and known limitations

Read this before relying on OpenExam for graded exams. It states what the
server enforces and where it depends on Safe Exam Browser (SEB) and on
people supervising the room.

### Enforced by the server

These hold no matter which client a student uses:

- A student can only read and answer their **own** exam session.
- Teacher routes check role and ownership.
- Solutions are stripped from the questions sent to students. MATCHING and
  ORDERING items are shuffled with a server-secret key.
- Deadlines, time extensions, locks and submission are decided server-side.
  Saves after submission, closure or a lock are refused.
- Sessions expire. After a logout or revocation, open WebSockets are
  disconnected at their next session check, within about 30 seconds.

### SEB: a configuration check, not client attestation

For an exam that requires SEB, every request must carry a valid Config Key
token. This proves the request was **built from this exam's `.seb`
configuration**. It does not prove that it came from SEB:

- **The config is the proof.** The manual browser download is one anonymous
  `.seb` file shared by every student. The normal `sebs://` launch instead
  fetches a per-session config: it embeds a short-lived one-time sign-in
  token (5 minutes) and its Config Key is stored on that student's session,
  so personalized configs are not interchangeable and should not be shared.
  Either file is compressed, not encrypted. A technically capable student
  with a valid login could take the exam outside SEB's lockdown. The
  guarantees above still apply: their own session only, server-owned
  deadline.
- **The User-Agent binding is a tripwire.** The first User-Agent seen is
  bound to the session. A later switch to an ordinary browser is rejected
  and audit-logged (not flagged to the invigilator).
  A client that imitates SEB from its first request is not caught.
- **The Browser Exam Key (BEK) is trust-on-first-use.** A change is flagged
  to the invigilator and the grader (`sebIntegrityFlaggedAt`), never
  blocked. A modified SEB used from the very first request is trusted.
  Real BEK attestation needs an allowlist of qualified client builds or a
  SEB Server. See [`lib/SEB_OUT_OF_SCOPE.md`](lib/SEB_OUT_OF_SCOPE.md).
- **SEB's own lockdown has limits.** On Windows and macOS it is enforced by
  an application and can be bypassed by a determined user.

**In practice:** treat SEB as a strong deterrent, not proof. For graded
exams, combine it with supervision: invigilators in the room, the live
monitor's integrity flags, and the audit log afterwards. For high-stakes
exams, use school-managed devices on which students cannot run their own
software. Test the generated `.seb` file on each platform and SEB version
you support before the first real exam; the checklist is in
`lib/SEB_OUT_OF_SCOPE.md` under "Manual SEB-client verification".

### Who can read everything

The server's operators can. With database access and `.env.prod` they can
read every exam, answer, grade and decrypted quit password. Choose and
restrict server admins on that basis. Field encryption (`AT_REST_ENC_KEY`)
covers only OAuth tokens and SEB quit passwords. Everything else in a
database dump is plaintext, and the key is stored in `.env.prod` on the same
host. Off-site backups are encrypted client-side before they leave the
server, unless encryption was declined during setup.

## Automated scanning

CI runs a dedicated `.github/workflows/security.yml` pipeline on every push,
every PR, and weekly on a schedule:

- **Secret scanning** — gitleaks over the full git history and PR diff.
- **Dependency review** — blocks PRs that introduce new high/critical
  advisories.
- **`pnpm audit`** — production dependency vulnerabilities (npm ecosystem).
- **`govulncheck`** — Go vulnerability scan for `ws-backend/`.
- **Container image scanning** — Trivy against both Docker images (`web`,
  `ws-backend`), CRITICAL/HIGH severities.
- **SAST** — Semgrep with standard rule packs plus a project-specific
  ruleset (`.github/semgrep.yml`).
- **Dependabot** — weekly update PRs for npm, GitHub Actions, Docker and Go
  (`ws-backend`).

Findings are uploaded to the repository's **Security → Code scanning**
tab as SARIF.

`secrets`, `go-vulncheck` and `container-scan` (CRITICAL/HIGH) block
merges. `pnpm-audit` and `semgrep` are advisory, and `dependency-review`
and the SARIF uploads need GitHub Advanced Security / Dependency Graph
enabled in the repository settings.

## Monitoring stack credentials

The optional monitoring stack (`scripts/setup-monitoring.sh`; see
`DEPLOYMENT.md`'s "Monitoring & Alerting") introduces Grafana and GlitchTip
admin logins. These follow the same model as every other secret: they live
in `.env.prod` (chmod 600, gitignored), and neither service is ever
internet-reachable — both are reachable only via SSH tunnel, the same
posture already applied to the Cap CAPTCHA admin dashboard. If `.env.prod`
leaks, the blast radius for these two credentials is bounded by "attacker
already has network access to the internal Docker network," same reasoning
as `CAP_ADMIN_KEY`.

**Error data egress to GlitchTip.** `lib/audit.ts` attaches audit
context (client IPs, User-Agent, metadata) to the errors it reports to
GlitchTip, and `lib/logger.ts`/`Sentry.init` forward server errors there
too. GlitchTip is unreachable from the internet, but treat GlitchTip as a place where IP addresses and
attacker-controlled input accumulate, and scrub/rotate its database
alongside the rest of the stack. Do not add PII fields to log contexts
without revisiting this note.

## Manual repository settings

The following require a GitHub Settings toggle and can't be expressed as a
committed file — enable both under **Settings → Code security**:

- **Secret scanning** — GitHub's own scanner, complements gitleaks.
- **Push protection** — blocks commits containing recognized secret
  patterns before they land in history.
