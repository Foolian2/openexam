# check=skip=SecretsUsedInArgOrEnv
# ^ Must stay the first line: BuildKit only honours a parser directive before
# any other content. It suppresses the SecretsUsedInArgOrEnv warning on the
# `ENV DATABASE_URL/BETTER_AUTH_SECRET/...` block in the build stage further
# down. The linter matches on variable *names*, so it cannot tell a real
# credential from the dummy literals used there. Those values are placeholders
# that satisfy import-time env guards during `next build`, and the `runner`
# stage starts from a fresh base rather than the build stage, so none of them
# exist in the shipped image (verify with
# `docker run --rm --entrypoint env openexam-web:<tag> | grep BETTER_AUTH`).
# Real secrets are injected at runtime from .env.prod by Compose.
#
# Production image for the Next.js app (PRD §16.1 "openexam-web").
# Targets:
#   runner  — the web server (default)
#   migrate — one-shot `prisma migrate deploy`, run as its own compose service
#             so the web replicas never race migrations on boot.
#
# Base images pinned by digest (linux/amd64): a re-pointed `node:26-alpine`
# tag would otherwise be pulled silently on the next build. Bump via
# Dependabot and re-verify before adopting a new base.

# node:26-alpine (2026-08-12)
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS base
# The pinned digest ships OpenSSL 3.5.7-r0, which carries CVE-2026-14456
# (unbounded memory growth in the QUIC server, HIGH). Alpine v3.24/main
# already has the patched 3.5.8-r0, but upstream node:26-alpine has not been
# rebuilt against it — bumping the pin would change nothing. Upgrade the two
# packages in place instead, so the fail-closed Trivy gate stays meaningful
# rather than being papered over with an ignore entry.
#
# Named explicitly rather than a blanket `apk upgrade`: a full upgrade would
# silently drift every OS package away from the pinned digest, which is the
# reproducibility the digest pin exists to provide. Drop this once a rebuilt
# base image ships 3.5.8-r0 (the layer then becomes a no-op, not an error).
RUN apk upgrade --no-cache libcrypto3 libssl3
RUN npm install -g pnpm@12.3.4

FROM base AS deps
WORKDIR /app
# pnpm-workspace.yaml carries onlyBuiltDependencies for the Prisma engines —
# it must be present before install or postinstall builds are skipped.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Baked into the client bundle (lib/auth-client.ts) — the image is domain-specific.
ARG NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL
# Baked into the cap widget's data-cap-api-endpoint at build time
# (components/auth/cap-widget.tsx). Site key included — it's public, unlike
# CAP_SECRET_KEY. Compose passes the relative /cap-api/<site-key>/ path;
# without it the widget throws "Missing API endpoint" and every captcha gate
# (sign-up, sign-in, access-code join) breaks.
ARG NEXT_PUBLIC_CAP_WIDGET_ENDPOINT
ENV NEXT_PUBLIC_CAP_WIDGET_ENDPOINT=$NEXT_PUBLIC_CAP_WIDGET_ENDPOINT
# Baked into the /cap-api/ rewrite at build time (rewrites are part of the
# standalone manifest, runtime env can't change them). Compose passes the
# internal-network URL (http://cap:3000); leaving it unset keeps the
# localhost:8090 dev default, which only makes sense for non-Docker dev.
ARG CAP_ORIGIN
ENV CAP_ORIGIN=$CAP_ORIGIN
# Baked into the client bundle (instrumentation-client.ts) so browser-side
# GlitchTip capture is enabled. Safe to be public: the browser never dials
# this DSN directly (requests go through app/api/monitoring/tunnel), so its
# value only needs to be internally resolvable from inside the container
# network, never internet-reachable. Empty in dev/CI builds — the monitoring
# stack is opt-in — which leaves client-side capture disabled, matching the
# server-side SENTRY_DSN opt-out in instrumentation.ts.
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
# Dummy values to satisfy import-time env guards during `next build`
# (lib/prisma.ts, lib/auth.ts, lib/exam-session.ts). The clients are
# lazy — nothing connects at build time — and these never reach the runtime image.
# Deliberately no MICROSOFT_* placeholder: any of them opts Microsoft login in
# (lib/env.ts's microsoftConfigured), and the 1.7 provider resolves its issuer
# from the tenant's discovery document when the auth handler initializes, which
# a placeholder tenant cannot satisfy.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    BETTER_AUTH_SECRET="build-time-dummy" \
    MATCHING_ID_SECRET="build-time-dummy" \
    BETTER_AUTH_URL="http://localhost:3000"
RUN pnpm prisma generate
RUN pnpm build

FROM base AS migrate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
# One-off data migrations run in this image too (docker compose run --rm
# migrate pnpm tsx scripts/...), not just the schema DDL: they need the app's
# lib/ helpers — at-rest decryption, the Prisma client — which is why the
# generated client is built here as well.
COPY lib ./lib
# Named file, not the directory: .dockerignore excludes scripts/ and re-adds
# only this one, so an explicit COPY fails loudly if that exception is ever
# dropped instead of silently shipping an image without the migration.
COPY scripts/migrate-account-identity.ts ./scripts/
RUN pnpm prisma generate
CMD ["pnpm", "prisma", "migrate", "deploy"]

# Operator tool, never deployed: generates the SFTP backup keys and the
# recovery PDF (scripts/setup-walg-sftp.sh builds and runs it), so the
# production host needs Docker only, not Node or node_modules. Reuses the
# deps stage's full install (react, @react-pdf/renderer, qrcode).
FROM base AS walg-setup
WORKDIR /app
RUN apk add --no-cache openssh-keygen
COPY --from=deps /app/node_modules ./node_modules
# Re-added by name in .dockerignore, like the migration above.
COPY scripts/setup-walg-sftp.mjs ./scripts/
ENTRYPOINT ["node", "scripts/setup-walg-sftp.mjs"]

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# Same OpenSSL patch as the base stage — this stage starts from the pinned
# digest directly, so it does not inherit that layer. This is the image the
# Trivy gate actually scans (target: runner).
RUN apk upgrade --no-cache libcrypto3 libssl3
# The stock npm bundled with the base image ships its own dependency tree
# (brace-expansion, ip-address) with open HIGH advisories that trip the
# fail-closed Trivy gate. The runner serves the standalone Next.js server —
# nothing at runtime invokes npm or pnpm — so drop npm and its tree.
RUN npm uninstall -g npm
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
