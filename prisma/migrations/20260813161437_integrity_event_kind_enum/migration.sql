-- CreateEnum
CREATE TYPE "IntegrityEventKind" AS ENUM ('TAB_HIDDEN', 'WINDOW_BLUR', 'COPY_BLOCKED', 'PASTE_BLOCKED', 'CONTEXT_MENU_BLOCKED', 'DEVTOOLS_SUSPECTED', 'SHORTCUT_BLOCKED');

-- AlterTable: text -> enum. Every existing row holds one of the enum's
-- members (the allow-list was enforced at the WS boundary by
-- ws-backend's IntegrityEventKinds gate since the table was added), so the
-- cast below is total and no UPDATE is needed.
--
-- Hand-edited from Prisma's generated version: Prisma could not express
-- the cast and wanted to drop/recreate the column (impossible with data),
-- and its diff also picked up pre-existing divergences between this
-- branch's datamodel and the shared dev DB (the SessionStatus/
-- SubmissionType enum values pruned by 20260813130000_prune_dead_session_statuses
-- from another branch, and the raw-SQL trgm index that Prisma's DSL cannot
-- declare). Those are deliberately NOT reverted here: re-adding the pruned
-- enum values and resetting the status default would change behavior for
-- the running dev app, and dropping the trgm index would degrade exam
-- search. This migration is exactly the integrity-kind contract change.
ALTER TABLE "IntegrityEvent" ALTER COLUMN "kind" TYPE "IntegrityEventKind" USING ("kind"::text::"IntegrityEventKind");
