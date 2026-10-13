#!/bin/sh
# Healthy only when an SSH server answers at the far end of the forward. A
# bare port probe would pass as soon as the local listener is bound, even if
# the remote forward target is wrong or the connection has dropped.
timeout 8 nc -w 5 127.0.0.1 2222 </dev/null | head -c 4 | grep -q '^SSH-'
