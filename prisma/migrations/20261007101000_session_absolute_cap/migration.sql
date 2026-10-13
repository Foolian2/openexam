-- Absolute 30-day session lifetime (lib/session-cap.ts SESSION_ABSOLUTE_MAX_AGE_SECONDS).
-- better-auth's session.update.before hook clamps refreshes in both Redis and
-- Postgres; this trigger is the backstop for the ws-backend, which reads
-- sessions from Postgres only, and for any write path that bypasses the hook.
CREATE OR REPLACE FUNCTION "session_cap_expires_at"() RETURNS trigger AS $$
BEGIN
  IF NEW."expiresAt" > NEW."createdAt" + INTERVAL '30 days' THEN
    NEW."expiresAt" := NEW."createdAt" + INTERVAL '30 days';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_absolute_cap"
  BEFORE INSERT OR UPDATE OF "expiresAt", "createdAt" ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_cap_expires_at"();

-- Existing sessions older than the cap expire now instead of sliding on.
UPDATE "session"
SET "expiresAt" = "createdAt" + INTERVAL '30 days'
WHERE "expiresAt" > "createdAt" + INTERVAL '30 days';
