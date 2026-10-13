/**
 * better-auth 1.7 account-identity migration (Microsoft accounts).
 *
 * 1.7 keys a Microsoft Entra account by the directory-stable `oid` claim
 * instead of Entra's app-pairwise `sub` (see the provider helper's
 * `accountSubject` in better-auth/plugins/generic-oauth/providers/
 * microsoft-entra-id). A schema migration cannot do that rewrite: only the
 * stored ID tokens carry the `oid`, and they are encrypted at rest. Without
 * it every existing Microsoft row is orphaned and the next sign-in creates a
 * second account for the same person.
 *
 * 1.7.0-1.7.2 additionally keyed every account by (issuer, accountId) and
 * required an `account.issuer` column. 1.7.3 reverted that upstream, and
 * 20260916120000_account_identity_drop_issuer drops the column again, so this
 * script no longer writes or reads it — the identity it reconciles is the
 * (providerId, accountId) pair better-auth resolves sign-in by.
 *
 * Run order (see DEPLOYMENT.md), BEFORE the schema migration that adds the
 * unique index:
 *
 *   1. pnpm tsx scripts/migrate-account-identity.ts            # dry run
 *   2. pnpm tsx scripts/migrate-account-identity.ts --apply
 *   3. pnpm prisma migrate deploy
 *
 * All of it belongs in a maintenance window with authentication writes
 * stopped: a sign-in that lands between the rewrite and the unique index can
 * create exactly the duplicate the index then refuses. A deployment without
 * Microsoft login has nothing to do here — credential accounts are already
 * keyed by the linked user's id, and the script reports that and exits.
 *
 * Flags:
 *   --apply         Write the changes (default is a dry run that only reports).
 *   --mapping=FILE  JSON `{ "<old accountId>": "<oid>" }` from a trusted
 *                   Microsoft Entra export, for rows whose stored ID token is
 *                   missing or no longer verifiable.
 *   --allow-unverified-id-tokens
 *                   Accept a stored ID token whose signing key Microsoft no
 *                   longer publishes (key rotation retires the `kid` of older
 *                   tokens). Issuer, audience and tenant claims are still
 *                   checked; only the signature is not. Prefer --mapping.
 */
import { readFileSync } from "node:fs"
import { compactVerify, createRemoteJWKSet, decodeJwt } from "jose"
import { decryptSecret } from "@/lib/at-rest-encryption"
import { microsoftTenantIssue } from "@/lib/env"
import { prisma } from "@/lib/prisma"

const MICROSOFT_PROVIDER_ID = "microsoft-entra-id"

type AccountRow = {
  id: string
  userId: string
  providerId: string
  accountId: string
  idToken: string | null
}

type Resolution = {
  row: AccountRow
  accountId: string
  /** How the identity was established - printed so the run is auditable. */
  source: string
}

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const allowUnverified = args.includes("--allow-unverified-id-tokens")
const mappingPath = args
  .find((a) => a.startsWith("--mapping="))
  ?.slice("--mapping=".length)

function loadMapping(): Map<string, string> {
  if (!mappingPath) return new Map()
  const parsed: unknown = JSON.parse(readFileSync(mappingPath, "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${mappingPath}: expected a JSON object of oldAccountId -> oid`
    )
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  for (const [key, value] of entries) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `${mappingPath}: mapping for "${key}" is not a non-empty string`
      )
    }
  }
  return new Map(entries as [string, string][])
}

async function main() {
  const tenantId = process.env.MICROSOFT_TENANT_ID?.trim().toLowerCase()
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim()

  // Credential rows are keyed by the linked user's stable id (the email is a
  // mutable sign-in identifier and never the account key). better-auth has
  // always written them that way; an older or hand-seeded row that does not
  // is corrected here so it cannot collide under the unique index.
  const credentialMismatches = await prisma.$queryRaw<
    { id: string; userId: string; accountId: string }[]
  >`
    SELECT "id", "userId", "accountId"
    FROM "account"
    WHERE "providerId" = 'credential' AND "accountId" <> "userId"
  `

  const rows = await prisma.$queryRaw<AccountRow[]>`
    SELECT "id", "userId", "providerId", "accountId", "idToken"
    FROM "account"
    WHERE "providerId" = ${MICROSOFT_PROVIDER_ID}
  `
  console.log(
    `Microsoft account rows: ${rows.length}; ` +
      `credential rows with a non-canonical key: ${credentialMismatches.length}`
  )

  if (rows.length > 0) {
    const tenantIssue = microsoftTenantIssue(tenantId)
    if (tenantIssue) {
      throw new Error(
        `${rows.length} Microsoft account row(s) to migrate, but ${tenantIssue}`
      )
    }
    if (!clientId) {
      throw new Error(
        "MICROSOFT_CLIENT_ID must be set to validate the stored ID tokens' audience"
      )
    }
  }

  const mapping = loadMapping()
  const jwks = tenantId
    ? createRemoteJWKSet(
        new URL(
          `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
        )
      )
    : null

  const resolved: Resolution[] = []
  const unresolved: { row: AccountRow; reason: string }[] = []

  for (const row of credentialMismatches) {
    resolved.push({
      row: {
        id: row.id,
        userId: row.userId,
        providerId: "credential",
        accountId: row.accountId,
        idToken: null,
      },
      accountId: row.userId,
      source: "credential",
    })
  }

  for (const row of rows) {
    const mapped = mapping.get(row.accountId)
    if (mapped) {
      if (mapped === row.accountId) continue
      resolved.push({
        row,
        accountId: mapped,
        source: "entra export mapping",
      })
      continue
    }

    const claims = await readMicrosoftIdToken(row, {
      jwks,
      tenantId: tenantId as string,
      clientId: clientId as string,
    })
    if ("error" in claims) {
      unresolved.push({ row, reason: claims.error })
      continue
    }
    // Already keyed by `oid` - an earlier run, or an account created after the
    // upgrade. Nothing to rewrite.
    if (claims.oid === row.accountId) continue
    resolved.push({
      row,
      accountId: claims.oid,
      source: claims.source,
    })
  }

  // Collisions have to be found before anything is written: two rows that
  // resolve to the same identity are a data question (which row survives, and
  // does it even belong to one person?), never something a migration decides.
  //
  // The map is seeded with the identities already in the table, not just the
  // ones rewritten in this run: a partial earlier run, or a sign-in that
  // slipped through before the maintenance window closed, leaves rows this run
  // does not touch but that the unique index still has to coexist with.
  const existing = await prisma.$queryRaw<
    { id: string; userId: string; providerId: string; accountId: string }[]
  >`
    SELECT "id", "userId", "providerId", "accountId"
    FROM "account"
  `
  const rewritten = new Set(resolved.map((r) => r.row.id))
  const identityKey = (providerId: string, accountId: string) =>
    `${providerId} ${accountId}`
  const seen = new Map<string, { id: string; userId: string }>()
  // Rows the table already holds twice (untouched by this run) are just as
  // fatal to the unique index; catching them only after --apply would leave
  // the rewrite half done with the schema migration still blocked.
  const existingDuplicates: [
    { id: string; userId: string },
    { id: string; userId: string; providerId: string; accountId: string },
  ][] = []
  for (const row of existing) {
    if (rewritten.has(row.id)) continue
    const key = identityKey(row.providerId, row.accountId)
    const previous = seen.get(key)
    if (previous) existingDuplicates.push([previous, row])
    else seen.set(key, { id: row.id, userId: row.userId })
  }

  const collisions: [{ id: string; userId: string }, Resolution][] = []
  for (const r of resolved) {
    const key = identityKey(r.row.providerId, r.accountId)
    const previous = seen.get(key)
    if (previous) collisions.push([previous, r])
    else seen.set(key, { id: r.row.id, userId: r.row.userId })
  }

  for (const [previous, row] of existingDuplicates) {
    console.error(
      `COLLISION ${row.providerId} / ${row.accountId}: account ${previous.id} (user ${previous.userId}) ` +
        `and account ${row.id} (user ${row.userId}) already share this identity`
    )
  }
  for (const [previous, r] of collisions) {
    console.error(
      `COLLISION ${r.row.providerId} / ${r.accountId}: account ${previous.id} (user ${previous.userId}) ` +
        `and account ${r.row.id} (user ${r.row.userId})`
    )
  }
  for (const { row, reason } of unresolved) {
    console.error(
      `UNRESOLVED account ${row.id} (user ${row.userId}, provider ${row.providerId}): ${reason}`
    )
  }

  const bySource = new Map<string, number>()
  for (const r of resolved)
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
  for (const [source, count] of bySource) {
    console.log(`resolved via ${source}: ${count}`)
  }

  const collisionCount = collisions.length + existingDuplicates.length
  if (collisionCount > 0) {
    throw new Error(
      `${collisionCount} identity collision(s): reconcile the duplicate rows by hand before running with --apply`
    )
  }

  if (!apply) {
    console.log(
      `dry run - ${resolved.length} row(s) would be updated. Re-run with --apply to write.`
    )
  } else {
    // One transaction: a failure part-way must not leave some rows rewritten.
    await prisma.$transaction(
      resolved.map(
        (r) => prisma.$executeRaw`
          UPDATE "account" SET "accountId" = ${r.accountId}
          WHERE "id" = ${r.row.id}
        `
      )
    )
    console.log(`updated ${resolved.length} account row(s)`)
  }

  await reportCollisions()

  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.length} account row(s) could not be resolved - supply --mapping= from a trusted ` +
        `Entra export (or fix them by hand) before applying the schema migration`
    )
  }
}

/**
 * Reads the directory-stable `oid` out of the account's stored ID token.
 * The signature is verified against the tenant's published keys; Microsoft
 * retires signing keys over time, so a token whose `kid` is gone is only
 * accepted with --allow-unverified-id-tokens, and even then the issuer,
 * audience and tenant claims must match the configured tenant.
 */
async function readMicrosoftIdToken(
  row: AccountRow,
  ctx: {
    jwks: ReturnType<typeof createRemoteJWKSet> | null
    tenantId: string
    clientId: string
  }
): Promise<{ oid: string; source: string } | { error: string }> {
  if (!row.idToken) {
    return {
      error:
        "no stored ID token (supply --mapping= from a trusted Entra export)",
    }
  }

  let token: string
  try {
    token = decryptSecret(row.idToken)
  } catch {
    return {
      error:
        "stored ID token could not be decrypted (is AT_REST_ENC_KEY the key it was written with?)",
    }
  }

  let claims: Record<string, unknown>
  try {
    claims = decodeJwt(token) as Record<string, unknown>
  } catch {
    return { error: "stored ID token is not a readable JWT" }
  }

  if (
    typeof claims.tid !== "string" ||
    claims.tid.toLowerCase() !== ctx.tenantId
  ) {
    return {
      error: `ID token tenant claim "${String(claims.tid)}" is not the configured tenant`,
    }
  }
  if (claims.iss !== `https://login.microsoftonline.com/${ctx.tenantId}/v2.0`) {
    return {
      error: `ID token issuer "${String(claims.iss)}" is not the configured tenant's issuer`,
    }
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(ctx.clientId)) {
    return { error: "ID token audience is not MICROSOFT_CLIENT_ID" }
  }
  const oid = typeof claims.oid === "string" ? claims.oid.trim() : ""
  if (!oid) return { error: "ID token carries no oid claim" }

  // compactVerify, not jwtVerify: these tokens are long expired by now, and
  // what matters here is provenance (Microsoft signed this), not freshness.
  if (ctx.jwks) {
    try {
      await compactVerify(token, ctx.jwks)
      return { oid, source: "verified ID token" }
    } catch (error) {
      if (!allowUnverified) {
        return {
          error:
            `ID token signature could not be verified (${(error as Error).message}); ` +
            `Microsoft may have retired the signing key - re-run with --mapping= ` +
            `or --allow-unverified-id-tokens`,
        }
      }
    }
  }
  return { oid, source: "unverified ID token (claims checked)" }
}

/** Re-runs the identity collision query against the live table. */
async function reportCollisions() {
  const duplicates = await prisma.$queryRaw<
    {
      providerId: string
      accountId: string
      accountcount: bigint
      usercount: bigint
    }[]
  >`
    SELECT "providerId", "accountId", COUNT(*) AS accountcount, COUNT(DISTINCT "userId") AS usercount
    FROM "account"
    GROUP BY "providerId", "accountId"
    HAVING COUNT(*) > 1
  `
  if (duplicates.length === 0) {
    console.log("collision check: no duplicate (providerId, accountId) pairs")
    return
  }
  for (const d of duplicates) {
    console.error(
      `COLLISION in table: ${d.providerId} / ${d.accountId} - ${d.accountcount} row(s) ` +
        `across ${d.usercount} user(s)`
    )
  }
  throw new Error(
    "duplicate (providerId, accountId) pairs remain; the unique index migration would fail"
  )
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
