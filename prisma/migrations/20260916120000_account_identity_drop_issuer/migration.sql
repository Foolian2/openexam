-- Reverts 20260820150000_account_identity_issuer, because better-auth
-- reverted the feature it was written for.
--
-- 1.7.0-1.7.2 identified an external account by (issuer, accountId) and wrote
-- an `issuer` on every account row. 1.7.3 dropped the column from its core
-- table definition (@better-auth/core's getAuthTables) and went back to
-- keying accounts by (providerId, accountId). Nothing writes `issuer` any
-- more, so with the column still NOT NULL every account write — including the
-- one behind email+password sign-up — fails with "Argument `issuer` is
-- missing".
--
-- The Microsoft half of that migration stands: better-auth still keys Entra
-- accounts by the directory-stable `oid` claim (the provider helper's
-- accountSubject), not the app-pairwise `sub`, so any deployment that ran
-- scripts/migrate-account-identity.ts keeps the account ids it wrote.
BEGIN;

DROP INDEX IF EXISTS "account_issuer_accountId_uidx";

ALTER TABLE "account" DROP COLUMN IF EXISTS "issuer";

-- The uniqueness guarantee moves to the pair better-auth resolves sign-in by.
-- It refuses to sign in at all when two rows share one identity
-- ("Multiple accounts match the same accountId for provider ..."), so the
-- index turns a login-time failure into a write-time one. Every row that
-- satisfied the (issuer, accountId) index above satisfies this one as well:
-- an issuer belongs to exactly one configured provider.
--
-- If this fails, the table already holds duplicate identities. That is a data
-- question — which row survives, and does it even belong to one person? — so
-- it is left to be reconciled by hand rather than resolved here; nothing is
-- committed until it is.
CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" ("providerId", "accountId");

COMMIT;
