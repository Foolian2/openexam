-- Sign-out-all and user-deletion cascades look up "session" rows by userId;
-- unindexed this is a full scan once the table grows past a handful of users.
CREATE INDEX "session_userId_idx" ON "session" ("userId");

-- Settings-page account lookups filter by (userId, providerId); OAuth
-- link/sign-in flows filter by userId alone, which this index also covers
-- as a prefix.
CREATE INDEX "account_userId_providerId_idx" ON "account" ("userId", "providerId");

-- Email verification / password reset flows look up "verification" rows by
-- identifier (the email address), never by id.
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
