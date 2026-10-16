"""Operator-side lab probes. Passwords stay in process memory; only safe outcomes print."""
import imaplib
import json
import smtplib
import ssl
import subprocess
import sys
import time
import socket
from pathlib import Path
from common import CONFIG, STATE, password, password_hash, atomic

ADDRESS='pilot@tenant-a.lab.invalid'
context=ssl.create_default_context(cafile=str(CONFIG/'ssl/lab-cert.pem'))
context.check_hostname=False  # Self-signed, isolated lab only; certificate still verified against lab CA.

def auth():
    result={'imap':False,'smtp':False}
    try:
        with imaplib.IMAP4_SSL('localhost',993,ssl_context=context,timeout=15) as client:
            result['imap']=client.login(ADDRESS,password(ADDRESS))[0]=='OK'
    except (imaplib.IMAP4.error,OSError): pass
    try:
        with smtplib.SMTP('localhost',587,timeout=15) as client:
            client.starttls(context=context)
            result['smtp']=client.login(ADDRESS,password(ADDRESS))[0]==235
    except (smtplib.SMTPException,OSError): pass
    return result

def messages(append=False):
    with imaplib.IMAP4_SSL('localhost',993,ssl_context=context,timeout=20) as client:
        client.login(ADDRESS,password(ADDRESS))
        if append:
            status,_=client.append('INBOX',None,None,b'From: synthetic@lab.invalid\r\nSubject: Nuvomailo lab preservation marker\r\n\r\nSynthetic stored message.\r\n')
            if status!='OK': raise RuntimeError('MARKER_APPEND_FAILED')
        status,data=client.select('INBOX',readonly=True)
        return {'messages':int(data[0])}

def quota():
    with imaplib.IMAP4_SSL('localhost',993,ssl_context=context,timeout=60) as client:
        client.login(ADDRESS,password(ADDRESS))
        # Stay below DMS's 10 MB per-message limit: prove aggregate storage enforcement.
        payload=b'Subject: synthetic aggregate quota probe\r\n\r\n'+b'x'*(8*1024*1024)
        accepted=0
        for _ in range(30):
            try: status,data=client.append('INBOX',None,None,payload)
            except imaplib.IMAP4.error as error:
                status,data='NO',[str(error).encode()]
            if status!='OK':
                return {'overQuotaRejected':b'quota' in b''.join(data).lower(),'status':status,'acceptedMessages':accepted,'messageBytes':len(payload)}
            accepted+=1
        return {'overQuotaRejected':False,'status':'LIMIT_NOT_REACHED','acceptedMessages':accepted}

def quota_state():
    result=subprocess.run(['doveadm','quota','get','-u',ADDRESS],capture_output=True,text=True,timeout=15)
    return {'success':result.returncode==0,'runtime':result.stdout.strip()}

def argv_safe():
    needle=password(ADDRESS).encode()
    for path in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            if needle in path.read_bytes(): return {'passwordInArgv':True}
        except OSError: pass
    return {'passwordInArgv':False}

def scheme():
    # Isolated compatibility account, not a SaaS user or real customer credential.
    address='argon-probe@tenant-a.lab.invalid'
    try: hashed=password_hash(address,'ARGON2ID')
    except RuntimeError: return {'argon2idHashSupported':False,'authenticated':False}
    entries=[line for line in (CONFIG/'postfix-accounts.cf').read_text().splitlines() if line.split('|')[0]!=address]
    atomic(CONFIG/'postfix-accounts.cf','\n'.join(entries+[address+'|'+hashed])+'\n')
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        try:
            with imaplib.IMAP4_SSL('localhost',993,ssl_context=context,timeout=10) as client:
                client.login(address,password(address))
                return {'argon2idHashSupported':True,'authenticated':True}
        except (imaplib.IMAP4.error,OSError):time.sleep(1)
    return {'argon2idHashSupported':True,'authenticated':False}

def node_argon():
    data=json.load(sys.stdin)
    if set(data)!= {'password','hash'} or not data['hash'].startswith('$argon2id$') or '\n' in data['hash'] or len(data['password'])>128: raise RuntimeError('INVALID_COMPATIBILITY_FIXTURE')
    address='node-argon@tenant-a.lab.invalid'
    def check(encoded):
        entries=[line for line in (CONFIG/'postfix-accounts.cf').read_text().splitlines() if line.split('|')[0]!=address]
        atomic(CONFIG/'postfix-accounts.cf','\n'.join(entries+[address+'|{ARGON2ID}'+encoded])+'\n')
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            try:
                with imaplib.IMAP4_SSL('localhost',993,ssl_context=context,timeout=10) as client:
                    client.login(address,data['password'])
                    return True
            except (imaplib.IMAP4.error,OSError):time.sleep(1)
        return False
    raw=check(data['hash'])
    parts=data['hash'].split('$')
    parameters=dict(pair.split('=') for pair in parts[3].split(','))
    parts[3]=','.join(key+'='+parameters[key] for key in ['m','t','p'])
    normalized=check('$'.join(parts))
    return {'nodeArgon2idAuthenticated':raw,'canonicalParameterOrderAuthenticated':normalized,'dashboardCredentialReused':False}

def backup():
    # A quiescent lab snapshot; no plaintext passwords, but key/seed/hash material is sensitive.
    directory=STATE/'snapshots'
    directory.mkdir(mode=0o700,exist_ok=True)
    output=directory/('lab-'+str(time.time_ns())+'.tar')
    subprocess.run(['tar','--exclude=management.lock','--exclude=snapshots','-cf',str(output),'-C','/','tmp/docker-mailserver','var/mail','var/mail-state','var/lib/nuvomailo-agent'],check=True,capture_output=True,timeout=90)
    # Restore into a fresh directory, never over the running provider volumes.
    restored=directory/('restore-'+str(time.time_ns()))
    restored.mkdir(mode=0o700)
    subprocess.run(['tar','-xf',str(output),'-C',str(restored)],check=True,capture_output=True,timeout=90)
    import hashlib
    sources=[CONFIG/'postfix-accounts.cf',CONFIG/'dovecot-quotas.cf',STATE/'revisions.json',STATE/'idempotency.json',STATE/'synthetic-seed']
    matched=all(hashlib.sha256(path.read_bytes()).digest()==hashlib.sha256((restored/str(path).lstrip('/')).read_bytes()).digest() for path in sources)
    mailfiles=list(Path('/var/mail/tenant-a.lab.invalid/pilot').rglob('*'))
    preserved=all((restored/str(path).lstrip('/')).is_file() and (restored/str(path).lstrip('/')).read_bytes()==path.read_bytes() for path in mailfiles if path.is_file())
    return {'metadataRestored':matched,'mailFilesRestored':preserved,'archiveBytes':output.stat().st_size,'coldBootRestoreTested':False}

def inbound():
    def count():
        output=subprocess.run(['doveadm','search','-u',ADDRESS,'mailbox','INBOX','all'],check=True,capture_output=True,text=True,timeout=15).stdout
        return len(output.splitlines())
    before=count()
    with smtplib.SMTP('mail',25,timeout=15) as client:
        client.starttls(context=context)
        refused=client.sendmail('',[ADDRESS],b'From: synthetic@tenant-b.lab.invalid\r\nTo: pilot@tenant-a.lab.invalid\r\nSubject: Isolated suspended-recipient probe\r\n\r\nSynthetic lab-only delivery.\r\n')
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        if count()>before:return {'smtpAccepted':not refused,'deliveredWhileAuthSuspended':True}
        time.sleep(.5)
    return {'smtpAccepted':not refused,'deliveredWhileAuthSuspended':False}

def custody():
    def count():
        output=subprocess.run(['doveadm','search','-u',ADDRESS,'mailbox','INBOX','all'],check=True,capture_output=True,text=True,timeout=15).stdout
        return len(output.splitlines())
    before=count()
    authenticated=auth()
    with smtplib.SMTP('mail',25,timeout=15) as client:
        client.starttls(context=context)
        client.ehlo('custody.lab.invalid')
        if client.mail('')[0]!=250: raise RuntimeError('MAIL_FROM_REJECTED')
        code,_=client.rcpt(ADDRESS)
        if code==250: client.data('Subject: custody probe\r\n\r\nSynthetic lab-only message.')
    time.sleep(1)
    return {'imapAuthenticated':authenticated['imap'],'submissionAuthenticated':authenticated['smtp'],
      'smtpRecipientCode':code,'messagesBefore':before,'messagesAfter':count()}

try:
    operation=sys.argv[1]
    if operation=='ready':
        with socket.create_connection(('localhost',993),timeout=2): pass
        result={'ready':Path('/run/nuvomailo-agent/agent.sock').exists()}
    elif operation=='auth':result=auth()
    elif operation=='append':result=messages(True)
    elif operation=='messages':result=messages()
    elif operation=='quota':result=quota()
    elif operation=='quota-state':result=quota_state()
    elif operation=='argv':result=argv_safe()
    elif operation=='scheme':result=scheme()
    elif operation=='argon-import':result=node_argon()
    elif operation=='backup':result=backup()
    elif operation=='inbound':result=inbound()
    elif operation=='custody':result=custody()
    elif operation=='ledger':
        data=json.loads((STATE/'revisions.json').read_text()) if (STATE/'revisions.json').exists() else {}
        result={'revisions':{key:value['revision'] for key,value in data.items()}}
    elif operation=='partial-fault': (STATE/'fail-after-account-once').touch();result={'armed':True}
    elif operation=='acceptance-fault': (STATE/'fail-after-accept-once').touch();result={'armed':True}
    elif operation=='alias':
        path=CONFIG/'postfix-virtual.cf'
        if not path.exists() or not any(line.startswith('collision@tenant-a.lab.invalid ') for line in path.read_text().splitlines()):
            subprocess.run(['setup','alias','add','collision@tenant-a.lab.invalid','pilot@tenant-a.lab.invalid'],check=True,capture_output=True,timeout=15)
        result={'aliasConfigured':True}
    elif operation=='drift':
        subprocess.run(['setup','quota','set',ADDRESS,'100M'],check=True,capture_output=True,timeout=15)
        result={'driftConfigured':True}
    else:raise RuntimeError('INVALID_LAB_PROBE')
    print(json.dumps(result))
except Exception as error:
    print(json.dumps({'error':'LAB_PROBE_FAILED','kind':type(error).__name__,'smtpCode':getattr(error,'smtp_code',None)}))
    sys.exit(1)
