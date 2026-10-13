FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
RUN apk add --no-cache openssh-client \
    && printf 'backup:x:999:999:Backup tunnel:/tmp:/sbin/nologin\n' >> /etc/passwd \
    && printf 'backup:x:999:\n' >> /etc/group
COPY tunnel.sh /usr/local/bin/tunnel
COPY healthcheck.sh /usr/local/bin/tunnel-healthcheck
USER 999:999
ENTRYPOINT ["/usr/local/bin/tunnel"]
