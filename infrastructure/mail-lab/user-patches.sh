#!/bin/bash
set -eu
python3 /opt/nuvomailo-lab/configure.py
# Local lab mail-node agent: no Docker API, no host sockets, fixed node-local scope.
cat > /etc/supervisor/conf.d/nuvomailo-agent.conf <<'EOF'
[program:nuvomailo-agent]
command=/usr/bin/python3 /opt/nuvomailo-lab/agent.py
autorestart=true
startsecs=1
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
EOF
supervisorctl reread >/dev/null
supervisorctl update >/dev/null
# Isolated mail must never route to the Internet, even if a network is later misconfigured.
postconf -e 'default_transport=error:Lab external delivery disabled'
postconf -e 'relay_transport=error:Lab external delivery disabled'
