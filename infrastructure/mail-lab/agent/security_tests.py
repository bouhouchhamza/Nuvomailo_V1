"""Executed synthetic security scenarios; assertions fail the process. No secret output."""
import imaplib
import json
import os
import smtplib
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from common import CONFIG, STATE, atomic, password

ADDRESS='security@tenant-a.lab.invalid'
BOX='abababab-abab-4bab-8bab-abababababab'
context=ssl.create_default_context(cafile=str(CONFIG/'ssl/lab-cert.pem'))
context.check_hostname=False
passed=[]

def rpc(target,uid=1000,authenticated=True,path='/v1/ensure'):
    result=subprocess.run(['python3','/opt/nuvomailo-lab/security_rpc.py'],
        input=json.dumps({'target':target,'authenticated':authenticated,'path':path}),
        text=True,capture_output=True,timeout=50,user=uid,group=3000,extra_groups=[])
    assert result.returncode==0,'RPC_FAILED'
    return json.loads(result.stdout)

def auth():
    results=[]
    try:
        with imaplib.IMAP4_SSL('localhost',993,ssl_context=context,timeout=10) as client:
            results.append(client.login(ADDRESS,password(ADDRESS))[0]=='OK')
    except imaplib.IMAP4.error: results.append(False)
    try:
        with smtplib.SMTP('localhost',587,timeout=10) as client:
            client.starttls(context=context)
            results.append(client.login(ADDRESS,password(ADDRESS))[0]==235)
    except smtplib.SMTPAuthenticationError: results.append(False)
    return results

def inbound(expected):
    with smtplib.SMTP('mail',25,timeout=10) as client:
        client.starttls(context=context)
        client.ehlo('security.lab.invalid')
        assert client.mail('')[0]==250
        code,_=client.rcpt(ADDRESS)
        assert code==expected,('UNEXPECTED_RCPT_CODE',code)
        if code==250:
            assert client.data('Subject: synthetic security policy marker\r\n\r\nRetained local fixture.')[0]==250
        # For 450 no DATA is submitted or accepted; remote MTA retains retry responsibility.
    return code

def count():
    result=subprocess.run(['doveadm','search','-u',ADDRESS,'mailbox','INBOX','all'],check=True,capture_output=True,text=True)
    return len(result.stdout.splitlines())

def next_target(status,policy):
    ledger=json.loads((STATE/'revisions.json').read_text())
    revision=ledger.get(BOX,{}).get('revision',0)+1
    return {'organizationId':'11111111-1111-4111-8111-111111111111','mailboxId':BOX,
        'address':ADDRESS,'quotaMb':100,'status':status,'inboundPolicy':policy,
        'revision':revision,'idempotencyKey':str(uuid.uuid4())}

if sys.argv[1]=='prepare':
    target=next_target('active','accept')
    assert rpc(target)['status']==200
    assert auth()==[True,True]
    entry=next(line for line in (CONFIG/'postfix-accounts.cf').read_text().splitlines() if line.startswith(ADDRESS+'|'))
    assert '|{ARGON2ID}$argon2id$' in entry
    passed.append('native-dovecot-argon2id-imap-and-submission')
    for key in ['password','hash','credential','command','path']:
        assert rpc({**target,key:'synthetic-rejected-value'})['status']==400
    assert rpc(target,authenticated=False)['status']==401
    assert rpc(target,uid=0)['status']==403
    assert rpc(target,path='/v1/exec')['status']==404
    passed.append('credential-fields-commands-token-and-peer-denied')
    with tempfile.TemporaryDirectory() as directory:
        victim=Path(directory)/'victim';victim.write_text('preserve')
        link=Path(directory)/'link';link.symlink_to(victim)
        try: atomic(link,'unsafe');raise AssertionError('SYMLINK_ACCEPTED')
        except RuntimeError: pass
        assert victim.read_text()=='preserve'
    passed.append('symlink-write-rejected')
    target=next_target('suspended','accept')
    assert rpc(target)['status']==200
    assert auth()==[False,False]
    before=count();inbound(250)
    for _ in range(40):
        if count()>before: break
        time.sleep(.25)
    assert count()>before
    passed.append('auth-only-suspension-still-stores-inbound')
    target=next_target('active','defer')
    assert rpc(target)['status']==200
    assert auth()==[True,True]
    inbound(450)
    assert rpc(target,path='/v1/inspect')['body']['inboundPolicy']=='defer'
    passed.append('inbound-only-deferral-keeps-client-authentication')
    target=next_target('suspended','defer')
    assert rpc(target)['status']==200
    before=count();inbound(450)
    assert count()==before
    assert rpc(target)['status']==200
    assert rpc({**target,'revision':target['revision']-1,'idempotencyKey':str(uuid.uuid4())})['body']['error']=='STALE_REVISION'
    assert rpc({**target,'inboundPolicy':'accept'})['body']['error']=='IDEMPOTENCY_CONFLICT'
    atomic(STATE/'security-target.json',json.dumps(target))
    passed.extend(['inbound-450-before-data-no-message-loss','replay-stale-and-policy-conflict-fenced'])
    protected=subprocess.run(['python3','-c',
        "from pathlib import Path; import os; assert not os.access('/var/lib/nuvomailo-agent/synthetic-seed',os.R_OK); assert not os.access('/tmp/docker-mailserver/postfix-accounts.cf',os.W_OK)"],
        user=3001,group=3000,extra_groups=[],capture_output=True)
    assert protected.returncode==0,'SERVICE_IDENTITY_OVERPRIVILEGED'
    assert rpc(target)['body']=={'status':'applied'}
    needles=[password(ADDRESS).encode(),Path('/run/nuvomailo-worker-auth/token').read_bytes(),entry.split('|',1)[1].encode()]
    for path in [STATE/'revisions.json',STATE/'idempotency.json']:
        assert all(needle not in path.read_bytes() for needle in needles),'JOURNAL_CREDENTIAL_EXPOSURE'
    for path in list(Path('/var/log').rglob('*'))+list(Path('/proc').glob('[0-9]*/cmdline')):
        try:
            if not path.is_file() or path.stat().st_size>20*1024*1024: continue
            contents=path.read_bytes()
            assert all(needle not in contents for needle in needles),'CREDENTIAL_EXPOSURE'
        except (PermissionError,FileNotFoundError,ProcessLookupError): pass
    passed.append('restricted-service-files-and-no-observed-secret-in-logs-or-argv')
elif sys.argv[1]=='restart':
    target=json.loads((STATE/'security-target.json').read_text())
    assert auth()==[False,False]
    inbound(450)
    assert rpc(target)['status']==200
    assert rpc({**target,'revision':target['revision']-1,'idempotencyKey':str(uuid.uuid4())})['status']==409
    before=count()
    target=next_target('active','accept')
    assert rpc(target)['status']==200
    assert auth()==[True,True]
    inbound(250)
    for _ in range(40):
        if count()>before: break
        time.sleep(.25)
    assert count()>before
    passed.extend(['restart-preserves-auth-inbound-and-fence','reactivation-delivers-retried-message-preserves-mail'])
else: raise AssertionError('UNKNOWN_SECURITY_PHASE')
assert password(ADDRESS) not in json.dumps(passed)
print(json.dumps({'phase':sys.argv[1],'passed':passed}))
