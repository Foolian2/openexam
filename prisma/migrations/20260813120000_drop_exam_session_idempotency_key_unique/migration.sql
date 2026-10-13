-- Replay detection compares idempotencyKey only against the same session's
-- own stored value (app/api/sessions/[id]/submit/route.ts), so a global
-- unique constraint bought nothing but let one session's key collide with
-- an unrelated session's, turning a legitimate submit into an uncaught
-- Prisma P2002 -> bodyless HTTP 500 (the client then retries the same key
-- forever). See prisma/schema.prisma's idempotencyKey comment.
DROP INDEX "ExamSession_idempotencyKey_key";
