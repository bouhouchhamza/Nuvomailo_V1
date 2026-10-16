import os
import subprocess
from common import STATE, CONFIG, atomic, password_hash

os.umask(0o077)
STATE.mkdir(parents=True, exist_ok=True)
CONFIG.mkdir(parents=True, exist_ok=True)
seed = STATE / 'synthetic-seed'
if not seed.exists():
    fd = os.open(seed, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as handle: handle.write(os.urandom(48))
auth = '/run/nuvomailo-worker-auth'
os.makedirs(auth, exist_ok=True)
os.chown(auth, 0, 3000)
os.chmod(auth, 0o750)
if not os.path.exists(auth+'/token'):
    atomic(auth+'/token', os.urandom(48).hex(), 0o640)
os.chown(auth+'/token', 0, 3000)
os.chmod(auth+'/token', 0o640)
if not (CONFIG / 'postfix-accounts.cf').exists():
    atomic(CONFIG / 'postfix-accounts.cf', 'bootstrap@tenant-a.lab.invalid|'+password_hash('bootstrap@tenant-a.lab.invalid')+'\n')
ssl = CONFIG / 'ssl'
ssl.mkdir(exist_ok=True)
if not (ssl/'lab-key.pem').exists():
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(ssl/'lab-key.pem'),'-out',str(ssl/'lab-cert.pem'),'-days','7','-subj','/CN=mail.lab.invalid'],check=True,capture_output=True)
print('Synthetic lab initialized; credential material not displayed', flush=True)
trust='/run/nuvomailo-public-trust'
os.makedirs(trust,exist_ok=True)
os.chmod(trust,0o755)
atomic(trust+'/lab-cert.pem',(ssl/'lab-cert.pem').read_text(),0o644)
for directory,owner,mode in [('/run/nuvomailo-broker-auth',0,0o750),('/run/nuvomailo-credential-vault',0,0o750),('/run/nuvomailo-credential-broker',3002,0o750)]:
    os.makedirs(directory,exist_ok=True);os.chown(directory,owner,3000);os.chmod(directory,mode)
for path,size in [('/run/nuvomailo-broker-auth/token',48),('/run/nuvomailo-credential-vault/key',32)]:
    if not os.path.exists(path):atomic(path,os.urandom(size).hex(),0o640)
    os.chown(path,0,3000);os.chmod(path,0o640)
