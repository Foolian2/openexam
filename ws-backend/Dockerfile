# Base images pinned by digest (linux/amd64) so a re-pointed tag can never be
# pulled silently; bump deliberately and re-verify.

# golang:1.27.2-alpine → go1.27.2 (2026-10-08): first 1.27 release with the
# crypto/tls, net/http and net/textproto fixes (GO-2026-6603 to GO-2026-6617).
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/ws-backend .

# gcr.io/distroless/static-debian12 (2026-08-12)
FROM gcr.io/distroless/static-debian12@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2
COPY --from=build /out/ws-backend /ws-backend
# distroless's built-in nonroot user. The backend writes nothing to disk and
# listens on an unprivileged port, so it needs no root at runtime.
USER 65532:65532
EXPOSE 8080
# Exec-form probe: distroless has no shell, so the binary probes itself
# (main.go: -healthcheck does a GET /healthz on 127.0.0.1:$PORT).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/ws-backend", "-healthcheck"]
ENTRYPOINT ["/ws-backend"]
