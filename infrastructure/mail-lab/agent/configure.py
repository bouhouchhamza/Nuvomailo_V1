from pathlib import Path
from common import CONFIG, atomic
import subprocess
path = Path('/etc/dovecot/conf.d/10-auth.conf')
marker = '# Nuvomailo isolated lab deny passdb'
block = marker+'''
passdb {
  driver = passwd-file
  args = /etc/dovecot/nuvomailo-deny
  deny = yes
}
'''
if marker not in path.read_text(): atomic(path,block+path.read_text(),0o644)
source=CONFIG/'nuvomailo-deny'
if not source.exists(): atomic(source,'',0o644)
atomic('/etc/dovecot/nuvomailo-deny',source.read_text(),0o644)
atomic('/etc/dovecot/conf.d/99-nuvomailo-lab-logging.conf',
       'auth_verbose_passwords = no\nauth_debug_passwords = no\n',0o644)
source=CONFIG/'nuvomailo-inbound'
if not source.exists(): atomic(source,'',0o644)
atomic('/etc/postfix/nuvomailo-inbound',source.read_text(),0o644)
rule='check_recipient_access texthash:/etc/postfix/nuvomailo-inbound'
existing=subprocess.run(['postconf','-h','smtpd_recipient_restrictions'],check=True,capture_output=True,text=True).stdout.strip()
if rule not in existing:
    existing=rule+', '+existing
    subprocess.run(['postconf','-e','smtpd_recipient_restrictions = '+existing],check=True,capture_output=True)
# DMS generates main.cf later during boot; persist its documented override too.
override=CONFIG/'postfix-main.cf'
previous=override.read_text().splitlines() if override.exists() else []
retained=[line for line in previous if not line.strip().startswith('smtpd_recipient_restrictions')]
atomic(override,'\n'.join(retained+['smtpd_recipient_restrictions = '+existing])+'\n',0o644)
