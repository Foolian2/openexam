-- Best-effort client-reported anti-cheating signals (tab switch, fullscreen
-- exit, clipboard/devtools attempt), surfaced on the teacher's live monitor.
-- See ws-backend/internal/hub/room.go (handleIntegrityEvent) for the writer.

CREATE TABLE "IntegrityEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "clientTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrityEvent_sessionId_idx" ON "IntegrityEvent"("sessionId");

ALTER TABLE "IntegrityEvent" ADD CONSTRAINT "IntegrityEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
