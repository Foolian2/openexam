-- better-auth 1.7 keys an external account by (issuer, accountId) instead of
-- (providerId, accountId). `issuer` is the provider's OpenID issuer, or a
-- synthetic `local:` namespace for internal methods.
--
-- PREREQUISITE for deployments with Microsoft (or any other OAuth) accounts:
-- run `pnpm tsx scripts/migrate-account-identity.ts --apply` BEFORE this
-- migration. Only credential rows can be resolved in SQL; every OAuth row
-- needs the provider's real issuer, and Microsoft rows additionally need
-- their account key rewritten from the app-pairwise `sub` to the
-- directory-stable `oid`, which the script reads out of the stored ID
-- tokens. The script creates this column itself (IF NOT EXISTS below makes
-- the two orders equivalent) and backfills it.
--
-- If this migration fails on the NOT NULL below, that prerequisite was
-- skipped. The statements run inside one explicit transaction, so nothing is
-- committed; run
--   pnpm prisma migrate resolve --rolled-back 20260820150000_account_identity_issuer
-- run the script, and deploy again.
BEGIN;

ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" TEXT;

-- Credential (email + password) accounts live in the synthetic `local:`
-- namespace: better-auth writes `local:credential` for every row it creates
-- through sign-up, password reset and admin user creation.
UPDATE "account" SET "issuer" = 'local:credential'
WHERE "providerId" = 'credential' AND ("issuer" IS NULL OR "issuer" = '');

-- A credential account's key is the linked user's stable id (the email is a
-- mutable sign-in identifier and never the account key). Rows written by
-- better-auth already satisfy this; the update is here so an older or
-- hand-seeded row cannot collide under the unique index below.
UPDATE "account" SET "accountId" = "userId"
WHERE "providerId" = 'credential' AND "accountId" <> "userId";

-- Fails loudly when an OAuth row is still unresolved, which is the intended
-- outcome: an account identity that cannot be established from trusted
-- provider data must be fixed by hand, never guessed.
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

-- One external identity resolves to exactly one local account row.
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");

COMMIT;
