import "dotenv/config"
import { defineConfig } from "prisma/config"

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // No startup guard here on purpose, unlike lib/prisma.ts. This file is
    // read by the Prisma CLI, and the Dockerfile's `migrate` stage runs
    // `prisma generate` with no DATABASE_URL set at all (the build-time ENV
    // block belongs to the `builder` stage). `generate` never opens the
    // datasource, so undefined is fine there; throwing on load would break
    // that image build instead of catching a real misconfiguration. The
    // runtime client validates the variable properly.
    // nosemgrep: openexam-database-url-non-null-assertion
    url: process.env.DATABASE_URL!,
    // Only read when a command needs it (e.g. `prisma migrate diff
    // --from-migrations`), so it's safe to leave unset for every other job.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
