/**
 * Backfills SEB secrets after a settings change.
 *
 * The Config Key is a hash of the settings dict, so any change to
 * `buildSebSettings` invalidates every previously persisted key — and the request
 * guard fails closed, which means affected exams would deny every student until
 * the key is recomputed. The migration nulls the stale keys; this script gives
 * each SEB exam a quit password and a matching fresh Config Key in one pass.
 *
 * Safe to re-run: it only writes exams whose key is missing or stale.
 *
 *   pnpm seb:regenerate-keys
 *
 * That line is for local use only. NEITHER production image can run it: the
 * `runner` stage is a standalone Next.js server with npm/pnpm deliberately
 * removed, and the `migrate` stage carries only prisma/ — no scripts/, no lib/.
 * In production, mount the repo into the migrate image, which already has
 * node_modules and DATABASE_URL on the internal network:
 *
 *   BASE=$(grep ^NEXT_PUBLIC_BASE_URL= .env.prod | cut -d= -f2-)
 *   KEY=$(grep ^AT_REST_ENC_KEY= .env.prod | cut -d= -f2-)
 *   SEB_VERSIONS=$(grep ^SEB_ALLOWED_VERSIONS= .env.prod | cut -d= -f2-)
 *   docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm \
 *     -v "$PWD:/app" -w /app \
 *     -e NEXT_PUBLIC_BASE_URL="$BASE" -e AT_REST_ENC_KEY="$KEY" -e NODE_ENV=production \
 *     -e SEB_ALLOWED_VERSIONS="$SEB_VERSIONS" \
 *     --entrypoint sh migrate -c "node_modules/.bin/tsx scripts/regenerate-seb-config-keys.ts"
 *
 * AT_REST_ENC_KEY is not optional: quit passwords are encrypted at rest and
 * ensureSebQuitPassword decrypts each one, so without it the run dies on the
 * first exam with "Unsupported state or unable to authenticate data".
 *
 * SEB_ALLOWED_VERSIONS must be passed too, even when unset (an empty
 * `-e SEB_ALLOWED_VERSIONS=""` is fine): generateSebConfig below reads it
 * from process.env like every other buildSebSettings input, and if it
 * disagrees with what the web tier's own SEB_ALLOWED_VERSIONS bakes into the
 * plist, this script computes Config Keys for the wrong settings — students
 * get a config the fail-closed guard was never told to expect, denying the
 * whole cohort once the mismatched key is compared against the fresh plist.
 */
import { prisma } from "@/lib/prisma"
import { computeSebConfigKey } from "@/lib/seb-issuance"
import { requireSebBaseUrl } from "@/lib/seb-urls"

async function main() {
  const baseUrl = requireSebBaseUrl()

  const exams = await prisma.exam.findMany({
    where: { sebRequired: true },
    select: {
      id: true,
      title: true,
      allowSpellCheck: true,
      sebConfigKey: true,
    },
  })

  console.log(`Found ${exams.length} SEB exam(s). Base URL: ${baseUrl}`)

  let updated = 0
  for (const exam of exams) {
    // Through lib/seb-issuance.ts so this site derives the quit password and
    // the exam key salt from the same persisted values the .seb download uses
    // — both are hashed into the Config Key, and a site that computed either
    // one differently would write a key no issued config matches.
    const configKey = await computeSebConfigKey(exam, baseUrl)

    if (exam.sebConfigKey === configKey) {
      console.log(`  = ${exam.id}  ${exam.title} — already current`)
      continue
    }

    // Everything derived from the settings dict is now stale, for every session
    // of this exam — not just the ones holding a personalized key:
    //
    //  - sebConfigKey: the per-session key differs from the exam-level one only
    //    in startURL's login token, so it went stale for the same reason.
    //    Leaving it would silently break this script's contract — a student
    //    holding a pre-change .seb file would still validate against their own
    //    stored key long after "every previously issued config is now invalid"
    //    was printed below.
    //  - sebKeyHash: a token computed from the key being discarded. Keeping it
    //    rejects the student's first request with the replacement config, and
    //    this applies to sessions that only ever used the anonymous config too
    //    — theirs was computed from the exam-level key that just changed.
    //  - sebBrowserExamKey: SEB derives the BEK by HMAC over the settings, so a
    //    settings change moves it. Keeping the old value would flag the whole
    //    cohort "SEB geändert" on their first request with the new config —
    //    which is why any flag it already produced is cleared alongside it.
    //
    // sebUserAgent is deliberately kept, so the rebind still has to come from
    // the machine already on record.
    //
    // One transaction with the exam-level write, not two statements. Split, a
    // crash or a failure between them left the new exam key committed while
    // stale per-session keys survived — and the equality check above would then
    // treat the exam as current on every rerun and skip this cleanup forever,
    // so pre-change .seb files would keep authorizing sessions in permanent
    // contradiction of the "every previously issued config is now invalid"
    // line this script prints at the end.
    const [, { count }] = await prisma.$transaction([
      prisma.exam.update({
        where: { id: exam.id },
        data: { sebConfigKey: configKey },
      }),
      prisma.examSession.updateMany({
        where: { examId: exam.id },
        data: {
          sebConfigKey: null,
          sebKeyHash: null,
          sebBrowserExamKey: null,
          sebIntegrityFlaggedAt: null,
          sebIntegrityReason: null,
        },
      }),
    ])

    updated++
    console.log(
      `  ✓ ${exam.id}  ${exam.title}` +
        (count > 0 ? ` (reset SEB state on ${count} session(s))` : "")
    )
  }

  console.log(
    `\nRegenerated ${updated} Config Key(s).` +
      (updated > 0
        ? "\nAny .seb file handed out before this run is now invalid — students must download the exam's SEB config again."
        : "")
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
