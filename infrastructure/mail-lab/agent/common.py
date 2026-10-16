"""Lab-only synthetic credentials; no passwords in argv, logs, responses or DB."""
import hashlib
import hmac
import os
import subprocess
import secrets
from pathlib import Path

STATE = Path('/var/lib/nuvomailo-agent')
CONFIG = Path('/tmp/docker-mailserver')

def password(address):
    return hmac.new((STATE / 'synthetic-seed').read_bytes(), address.encode(), hashlib.sha256).hexdigest()

def password_hash(address, scheme='SHA512-CRYPT'):
    # Dovecot's interactive stdin, captured output: never -p or environment variables.
    value = password(address)
    result = subprocess.run(['doveadm', 'pw', '-s', scheme], input=value+'\n'+value+'\n', text=True, capture_output=True, timeout=20)
    if result.returncode:
        raise RuntimeError('HASH_SCHEME_UNAVAILABLE')
    return result.stdout.strip()

def atomic(path, value, mode=0o600):
    path = Path(path)
    # Trusted parent directories only; never follow a pre-created temporary link.
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError('UNSAFE_CONFIGURATION_PATH')
    temporary = path.with_name('.'+path.name+'.'+secrets.token_hex(16)+'.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'w') as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
