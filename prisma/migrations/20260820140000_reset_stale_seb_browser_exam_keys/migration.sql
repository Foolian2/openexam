-- Resets Browser Exam Key attestation state, which the previous code could only
-- ever have populated with unusable values.
--
-- The bound key was read from SEB's own x-safeexambrowser-requesthash header,
-- which carries sha256(requestURL + BEK) — a different value for every endpoint
-- the client touches. Trust-on-first-use therefore compared the take page's hash
-- against /api/sessions/*'s and flagged "bek_changed" on the student's very
-- first poll. Both SEB sessions sat on 2026-08-20 were flagged within
-- milliseconds of theirs.
--
-- lib/seb-guard.ts now reads the URL-independent value from our own
-- x-openexam-seb-requesthash header instead (see SEB_BEK_HEADER there), so every
-- key bound before this migration is in the wrong namespace and would mismatch
-- on the next request, producing the same false flag again. Clearing it makes
-- each session rebind from the new header; the binding is trust-on-first-use, so
-- nothing is lost but the false positives.
UPDATE "ExamSession"
SET "sebIntegrityFlaggedAt" = NULL,
    "sebIntegrityReason" = NULL
WHERE "sebIntegrityReason" = 'bek_changed';

-- Deliberately not scoped to flagged rows: an unflagged session holding a
-- per-URL hash is simply one that has not made its second request yet.
UPDATE "ExamSession"
SET "sebBrowserExamKey" = NULL
WHERE "sebBrowserExamKey" IS NOT NULL;
