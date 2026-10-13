## What

<!-- What does this PR change, and why? Link the issue it closes if there is one. -->

## Verification

<!-- How did you confirm this works? Be concrete — commands run, tests added, manual steps taken.
     e.g.:
     - `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass
     - Added/updated a test in __tests__/ covering the new behavior
     - Manually verified against a local `docker compose up` stack: <what you did> -->

## Notes

<!-- Anything a reviewer needs but isn't obvious from the diff: deliberate tradeoffs, things you
     considered and rejected, follow-ups you're deferring, secrets/config NOT included in this
     diff, etc. Delete this section if there's nothing to add. -->

---

### Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally (or `go build ./... && go vet ./...
      && go test ./...` for `ws-backend/` changes)
- [ ] Tests added/updated for the behavior this PR changes
- [ ] Touches nothing in CONTRIBUTING.md's "Security-sensitive areas" without extra scrutiny — or
      it does, and I've said so above
- [ ] Docs updated if this changes deployment, configuration, or user-facing behavior
      (`README.md`, `DEPLOYMENT.md`, `.env.example`, as applicable)
