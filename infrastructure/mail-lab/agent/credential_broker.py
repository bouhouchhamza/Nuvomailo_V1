"""Unprivileged synthetic native-hash broker. No mail/config/DB/Docker access."""
import hmac,json,os,resource,socket,socketserver,struct,subprocess
from pathlib import Path
from http.server import BaseHTTPRequestHandler

TOKEN=Path('/run/nuvomailo-broker-auth/token').read_text().strip()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        code=400;body={'error':'INVALID_REQUEST'}
        try:
            self.connection.settimeout(5)
            _,uid,gid=struct.unpack('3i',self.connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            if uid!=1000 or gid!=3000: code=403;raise ValueError()
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN): code=401;raise ValueError()
            if self.path!='/v1/hash': code=404;raise ValueError()
            size=int(self.headers.get('Content-Length','0'))
            if not 1<=size<=2048: raise ValueError()
            value=json.loads(self.rfile.read(size))
            if set(value)!={'password'} or not isinstance(value['password'],str) or not 12<=len(value['password'])<=128 or any(c in value['password'] for c in '\r\n\x00'): raise ValueError()
            # Native provider format; password is stdin only, never argv/env or logs.
            result=subprocess.run(['doveadm','pw','-s','ARGON2ID'],input=value['password']+'\n'+value['password']+'\n',text=True,capture_output=True,timeout=20)
            if result.returncode or not result.stdout.strip().startswith('{ARGON2ID}$argon2id$'): code=503;raise ValueError()
            code=200;body={'hash':result.stdout.strip()}
        except Exception:
            body={'error':'BROKER_REQUEST_REJECTED' if code!=503 else 'HASH_UNAVAILABLE'}
        encoded=json.dumps(body).encode()
        print(json.dumps({'event':'credential_hash','code':code}),flush=True)
        self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers()
        try:self.wfile.write(encoded)
        except (BrokenPipeError,ConnectionResetError):pass

if __name__=='__main__':
    if os.getuid()!=3002:raise RuntimeError('RESTRICTED_IDENTITY_REQUIRED')
    os.umask(0o007)
    resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    path='/run/nuvomailo-credential-broker/broker.sock'
    if os.path.lexists(path):os.unlink(path)
    with socketserver.UnixStreamServer(path,Handler) as server:
        os.chmod(path,0o660);server.serve_forever()
