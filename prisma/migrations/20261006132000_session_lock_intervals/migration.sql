CREATE TABLE "SessionLockInterval" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL,
    "unlockedAt" TIMESTAMP(3),

    CONSTRAINT "SessionLockInterval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SessionLockInterval_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "ExamSession"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SessionLockInterval_sessionId_lockedAt_unlockedAt_idx"
ON "SessionLockInterval"("sessionId", "lockedAt", "unlockedAt");

-- Preserve the active lock interval for sessions locked before this
-- migration. startedAt conservatively covers the whole session for legacy
-- rows missing lockedAt; their exact previous boundary cannot be recovered.
INSERT INTO "SessionLockInterval" ("sessionId", "lockedAt")
SELECT id, COALESCE("lockedAt", "startedAt", clock_timestamp() AT TIME ZONE 'UTC')
FROM "ExamSession"
WHERE status = 'LOCKED';
