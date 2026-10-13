FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
RUN apk add --no-cache openssh-server \
 && printf 'walg:x:1001:1001:SFTP backup:/home/walg:/bin/sh\n' >> /etc/passwd \
 && printf 'walg:x:1001:\n' >> /etc/group \
 && printf 'walg:x:20000:0:99999:7:::\n' >> /etc/shadow \
 && mkdir -p /home/walg/.ssh /srv/backups/archive \
 && chown -R 1001:1001 /home/walg /srv/backups/archive \
 && chmod 700 /home/walg/.ssh && ssh-keygen -A
COPY authorized_keys /home/walg/.ssh/authorized_keys
COPY sshd_config /etc/ssh/sshd_config
RUN chown 1001:1001 /home/walg/.ssh/authorized_keys \ 
 && chmod 600 /home/walg/.ssh/authorized_keys
ENTRYPOINT ["/usr/sbin/sshd", "-D", "-e"]
