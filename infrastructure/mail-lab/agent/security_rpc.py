"""Synthetic harness transport. No credential arguments or generic operation execution."""
import http.client
import json
import socket
import sys
from pathlib import Path

request=json.load(sys.stdin)
connection=http.client.HTTPConnection('localhost',timeout=45)
connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.sock.settimeout(45)
connection.sock.connect('/run/nuvomailo-agent/agent.sock')
token=Path('/run/nuvomailo-worker-auth/token').read_text()
connection.request('POST',request.get('path','/v1/ensure'),json.dumps(request['target']),
                   {'Authorization':'Bearer '+(token if request.get('authenticated',True) else 'invalid')})
response=connection.getresponse()
print(json.dumps({'status':response.status,'body':json.loads(response.read(8192))}))
