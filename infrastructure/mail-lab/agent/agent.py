"""Fixed-node lab management service. No Docker/socket/remote shell capability."""
import fcntl
import hmac
import json
import os
import re
import socketserver
import socket
import struct
import subprocess
import time
import uuid
import ctypes
import signal
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from common import STATE, CONFIG, atomic, password_hash

BINDINGS = {entry['mailboxId']: entry for entry in json.loads(Path('/opt/nuvomailo-bindings.json').read_text())}
SOCKET = '/run/nuvomailo-agent/agent.sock'
TOKEN = Path('/run/nuvomailo-worker-auth/token').read_text()
LEDGER = STATE / 'revisions.json'

class Denied(Exception):
    def __init__(self, code, status=409): self.code, self.status = code, status

def validate(value):
    keys={'organizationId','mailboxId','address','revision','quotaMb','status','idempotencyKey'}
    if not isinstance(value,dict) or set(value) not in [keys,keys|{'inboundPolicy'}]: raise Denied('INVALID_TARGET',400)
    if value.get('inboundPolicy','accept') not in ['accept','defer']: raise Denied('INVALID_TARGET',400)
    try:
        for key in ['organizationId','mailboxId','idempotencyKey']: uuid.UUID(value[key])
    except (ValueError,TypeError,AttributeError): raise Denied('INVALID_TARGET',400)
    if not isinstance(value['address'],str) or not re.fullmatch(r'[a-z0-9]+(?:[._-][a-z0-9]+)*@tenant-[ab]\.lab\.invalid',value['address']): raise Denied('INVALID_ADDRESS',400)
    if type(value['revision']) is not int or value['revision']<1 or type(value['quotaMb']) is not int or value['quotaMb'] not in [100,200] or value['status'] not in ['active','suspended']: raise Denied('INVALID_TARGET',400)
    binding=BINDINGS.get(value['mailboxId'])
    if not binding or any(value[key]!=binding[key] for key in ['organizationId','mailboxId','address']): raise Denied('TARGET_NOT_AUTHORIZED',403)
    return value

def run(args):
    result=subprocess.run(args,text=True,capture_output=True,timeout=10)
    if result.returncode: raise Denied('PROVIDER_UNAVAILABLE',503)
    return result.stdout

def validate_credential(value):
    if not isinstance(value,dict) or set(value)!={'organizationId','mailboxId','address','generation','idempotencyKey','hash'}:raise Denied('INVALID_CREDENTIAL_TARGET',400)
    binding=BINDINGS.get(value.get('mailboxId'))
    if not binding or any(value.get(key)!=binding[key] for key in ['organizationId','mailboxId','address']):raise Denied('TARGET_NOT_AUTHORIZED',403)
    try:uuid.UUID(value['idempotencyKey'])
    except (ValueError,TypeError,AttributeError):raise Denied('INVALID_CREDENTIAL_TARGET',400)
    if type(value['generation']) is not int or not 1<=value['generation']<=2147483647:raise Denied('INVALID_CREDENTIAL_TARGET',400)
    if not isinstance(value['hash'],str) or not value['hash'].startswith('{ARGON2ID}$argon2id$') or len(value['hash'])>512 or any(c in value['hash'] for c in '\r\n\x00|'):raise Denied('INVALID_CREDENTIAL_HASH',400)
    return value

def validate_routing(value):
    if not isinstance(value,dict) or set(value)!={'organizationId','domain','generation','idempotencyKey','routes'}:raise Denied('INVALID_ROUTING_TARGET',400)
    ownership={entry['address'].split('@')[1]:entry['organizationId'] for entry in BINDINGS.values()}
    if ownership.get(value.get('domain'))!=value.get('organizationId'):raise Denied('TARGET_NOT_AUTHORIZED',403)
    try:uuid.UUID(value['idempotencyKey'])
    except (ValueError,TypeError,AttributeError):raise Denied('INVALID_ROUTING_TARGET',400)
    if type(value['generation']) is not int or not 1<=value['generation']<=2147483647 or not isinstance(value['routes'],list) or len(value['routes'])>20:raise Denied('INVALID_ROUTING_TARGET',400)
    sources=set()
    for route in value['routes']:
        if not isinstance(route,dict) or set(route)!={'source','destinations'}:raise Denied('INVALID_ROUTING_TARGET',400)
        address=route['source']
        if not isinstance(address,str) or not re.fullmatch(r'[a-z0-9]+(?:[._-][a-z0-9]+)*@tenant-[ab]\.lab\.invalid',address) or len(address.split('@')[0])>64 or address.split('@')[1]!=value['domain'] or address in sources:raise Denied('INVALID_ROUTING_SOURCE',400)
        sources.add(address)
        if not isinstance(route['destinations'],list) or not 1<=len(route['destinations'])<=10 or len(set(route['destinations']))!=len(route['destinations']):raise Denied('INVALID_ROUTING_TARGET',400)
        for destination in route['destinations']:
            if not isinstance(destination,str) or not re.fullmatch(r'[a-z0-9]+(?:[._-][a-z0-9]+)*@tenant-[ab]\.lab\.invalid',destination) or ownership.get(destination.split('@')[1])!=value['organizationId']:raise Denied('ROUTING_DESTINATION_NOT_AUTHORIZED',403)
    if any(destination in sources for route in value['routes'] for destination in route['destinations']):raise Denied('ROUTING_LOOP',400)
    return value

def validate_usage(value):
    if not isinstance(value,dict) or set(value)!={'organizationId','mailboxId','address'}:raise Denied('INVALID_USAGE_TARGET',400)
    binding=BINDINGS.get(value.get('mailboxId'))
    if not binding or any(value.get(key)!=binding[key] for key in ['organizationId','mailboxId','address']):raise Denied('TARGET_NOT_AUTHORIZED',403)
    return value

def ensure_routing(target):
    path=STATE/'routing.json';ledger=json.loads(path.read_text()) if path.exists() else {}
    previous=ledger.get(target['domain']);old=previous['target'] if previous else None
    if old:
        if target['generation']<old['generation']:raise Denied('STALE_ROUTING_GENERATION')
        if target['generation']==old['generation'] and target!=old:raise Denied('ROUTING_GENERATION_CONFLICT')
    owned=set(previous['ownedSources'] if previous else [])
    sources={route['source'] for route in target['routes']}
    current=lines(CONFIG/'postfix-virtual.cf')
    for route in target['routes']:
        if configured(route['source']):raise Denied('ADDRESS_COLLISION')
        if route['source'] not in owned and any(line.split()[0]==route['source'] for line in current if line.strip()):raise Denied('ADDRESS_COLLISION')
        if any(not configured(destination) for destination in route['destinations']):raise Denied('ROUTING_DESTINATION_NOT_PROVISIONED')
    owned.update(sources);ledger[target['domain']]={'target':target,'ownedSources':sorted(owned)}
    atomic(path,json.dumps(ledger,sort_keys=True))
    retained=[line for line in current if not line.strip() or line.split()[0] not in owned]
    atomic(CONFIG/'postfix-virtual.cf','\n'.join(retained+[route['source']+' '+','.join(route['destinations']) for route in target['routes']])+'\n')
    started=time.monotonic();stable=None
    expected={route['source']:set(route['destinations']) for route in target['routes']}
    while time.monotonic()-started<25:
        correct=True
        for source in owned:
            actual=subprocess.run(['postmap','-q',source,'texthash:/etc/postfix/virtual'],capture_output=True,text=True,timeout=10)
            if actual.returncode not in [0,1] or {v.strip() for v in actual.stdout.strip().split(',') if v.strip()}!=expected.get(source,set()):correct=False;break
        if correct:
            if stable is None:stable=time.monotonic()
            if time.monotonic()-started>=4 and time.monotonic()-stable>=2:return {'status':'applied','generation':target['generation']}
        else:stable=None
        time.sleep(0.5)
    raise Denied('ROUTING_STATE_MISMATCH',503)

def validate_operation(operation,target):
    return validate_usage(target) if operation=='/v1/usage' else validate_routing(target) if operation=='/v1/routing' else validate_credential(target) if operation=='/v1/credential' else validate(target)

def usage(target):
    if not configured(target['address']):raise Denied('MAILBOX_NOT_PROVISIONED',404)
    try:rows=json.loads(run(['doveadm','-f','json','quota','get','-u',target['address']]))
    except json.JSONDecodeError:raise Denied('PROVIDER_UNAVAILABLE',503)
    storage=next((row for row in rows if row.get('type')=='STORAGE'),None)
    messages=next((row for row in rows if row.get('type')=='MESSAGE'),None)
    try:storage_kib=int(storage['value']);message_count=int(messages['value'])
    except (TypeError,ValueError,KeyError):raise Denied('PROVIDER_UNAVAILABLE',503)
    if storage_kib<0 or message_count<0 or storage_kib>9007199254740 or message_count>9007199254740991:raise Denied('PROVIDER_UNAVAILABLE',503)
    return {'usageBytes':storage_kib*1024,'messageCount':message_count}

def ensure_credential(target):
    import hashlib
    path=STATE/'credentials.json'
    ledger=json.loads(path.read_text()) if path.exists() else {}
    snapshot={key:value for key,value in target.items() if key!='hash'}
    snapshot['hashDigest']=hashlib.sha256(target['hash'].encode()).hexdigest()
    previous=ledger.get(target['mailboxId'])
    if previous:
        if target['generation']<previous['generation']:raise Denied('STALE_CREDENTIAL_GENERATION')
        if target['generation']==previous['generation'] and previous!=snapshot:raise Denied('CREDENTIAL_GENERATION_CONFLICT')
    if any(item['idempotencyKey']==target['idempotencyKey'] and item!=snapshot for item in ledger.values()):raise Denied('IDEMPOTENCY_CONFLICT')
    if not configured(target['address']):raise Denied('MAILBOX_NOT_PROVISIONED')
    ledger[target['mailboxId']]=snapshot
    atomic(path,json.dumps(ledger,sort_keys=True)) # Fence accepted before effects.
    update_line(CONFIG/'postfix-accounts.cf',target['address'],target['address']+'|'+target['hash'],'|')
    # FILE watcher applies provider-native hash; kick sessions even when reapplying after crash.
    started=time.monotonic();deadline=started+25;stable_since=None
    while time.monotonic()<deadline:
        if effective_hash(target['address'])==target['hash']:
            if stable_since is None:stable_since=time.monotonic()
            if time.monotonic()-started>=4 and time.monotonic()-stable_since>=2:
                subprocess.run(['doveadm','kick',target['address']],capture_output=True,timeout=10)
                return {'status':'applied','generation':target['generation']}
        else:stable_since=None
        time.sleep(0.5)
    raise Denied('CREDENTIAL_STATE_MISMATCH',503)

def lines(path):
    return Path(path).read_text().splitlines() if Path(path).exists() else []

def configured(address):
    return next((line for line in lines(CONFIG/'postfix-accounts.cf') if line.split('|')[0]==address),None)

def effective_hash(address):
    # DMS generates the effective passwd-file used by Dovecot, independently of intent.
    return next((line.split(':')[1] for line in lines('/etc/dovecot/userdb') if line.startswith(address+':')),None)

def inspect(target):
    address=target['address']
    # Read independent effective Dovecot state, not the just-written desired config.
    result=subprocess.run(['doveadm','user',address],text=True,capture_output=True,timeout=10)
    if result.returncode: return {'status':'unknown' if configured(address) else 'absent','quotaMb':None}
    rule=re.search(r'quota_rule\s+\*:bytes=(\d+)([kKmMgG]?)',result.stdout)
    scale={'':1,'k':1024,'m':1024**2,'g':1024**3}
    quota=int(rule.group(1))*scale[rule.group(2).lower()]//(1024*1024) if rule else None
    denied=set(line.split(':')[0] for line in lines('/etc/dovecot/nuvomailo-deny'))
    # Independently test the effective Dovecot passdb using synthetic stdin credentials.
    from common import password
    auth=subprocess.run(['doveadm','auth','test',address],input=password(address)+'\n',text=True,capture_output=True,timeout=10)
    managed_path=STATE/'credentials.json'
    managed=json.loads(managed_path.read_text()).get(target['mailboxId']) if managed_path.exists() else None
    if managed and address not in denied:
        # Managed credentials are not derived from the legacy fixture seed.
        # Independently read effective passdb; real-login proof is a separate client test.
        account=configured(address)
        status='active' if account and account.split('|',1)[1]==effective_hash(address) else 'unknown'
    elif address in denied and auth.returncode!=0: status='suspended'
    elif address not in denied and auth.returncode==0: status='active'
    else: status='unknown'
    observation={'status':status,'quotaMb':quota}
    if 'inboundPolicy' in target:
        restrictions=run(['postconf','-h','smtpd_recipient_restrictions'])
        lookup=subprocess.run(['postmap','-q',address,'texthash:/etc/postfix/nuvomailo-inbound'],capture_output=True,text=True,timeout=10)
        if lookup.returncode not in [0,1] or lookup.stderr.strip(): raise Denied('PROVIDER_UNAVAILABLE',503)
        actual=lookup.stdout.strip()
        observation['inboundPolicy']=('defer' if actual.startswith('450 ') else 'accept') if 'check_recipient_access texthash:/etc/postfix/nuvomailo-inbound' in restrictions else 'unknown'
    return observation

def update_line(path,address,value,separator):
    current=lines(path)
    retained=[line for line in current if line.split(separator)[0]!=address]
    atomic(path,'\n'.join(retained+[value])+'\n')

def ensure(target):
    address=target['address']
    ledger=json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
    snapshot=dict(target)
    # Historical snapshots omitted the explicit accept policy. Preserve replay compatibility.
    if snapshot.get('inboundPolicy')=='accept': snapshot.pop('inboundPolicy')
    keys_path=STATE/'idempotency.json'
    used=json.loads(keys_path.read_text()) if keys_path.exists() else {}
    # The fsynced idempotency journal is the acceptance authority. Reconstruct the
    # fence if a crash happened after its rename but before the convenience ledger.
    candidates=[value for value in used.values() if value['mailboxId']==target['mailboxId']]
    if target['mailboxId'] in ledger: candidates.append(ledger[target['mailboxId']])
    previous=max(candidates,key=lambda value:value['revision']) if candidates else None
    if target['idempotencyKey'] in used and used[target['idempotencyKey']]!=snapshot: raise Denied('IDEMPOTENCY_CONFLICT')
    if previous:
        if target['revision']<previous['revision']: raise Denied('STALE_REVISION')
        if target['revision']==previous['revision'] and snapshot!=previous: raise Denied('REVISION_CONFLICT')
    for other in ledger.values():
        if other['idempotencyKey']==target['idempotencyKey'] and other['mailboxId']!=target['mailboxId']: raise Denied('IDEMPOTENCY_CONFLICT')
    if any(line.split()[0]==address for line in lines(CONFIG/'postfix-virtual.cf') if line.strip()): raise Denied('ADDRESS_COLLISION')
    # Persist acceptance before effects. Retrying the same snapshot repairs partial effects.
    ledger[target['mailboxId']]=snapshot
    used[target['idempotencyKey']]=snapshot
    atomic(keys_path,json.dumps(used,sort_keys=True))
    acceptance_fault=STATE/'fail-after-accept-once'
    if address=='pilot@tenant-a.lab.invalid' and acceptance_fault.exists():
        acceptance_fault.unlink()
        raise Denied('INJECTED_ACCEPTANCE_FAILURE',503)
    atomic(LEDGER,json.dumps(ledger,sort_keys=True))
    if not configured(address):
        update_line(CONFIG/'postfix-accounts.cf',address,address+'|'+password_hash(address,'ARGON2ID'),'|')
    failure=STATE/'fail-after-account-once'
    if address=='partial@tenant-a.lab.invalid' and failure.exists():
        failure.unlink()  # Explicit synthetic fault marker, never mailbox data.
        raise Denied('INJECTED_PARTIAL_FAILURE',503)
    update_line(CONFIG/'dovecot-quotas.cf',address,address+':'+str(target['quotaMb']*1024*1024),':')
    denied={line.split(':')[0] for line in lines(CONFIG/'nuvomailo-deny') if line.strip()}
    if target['status']=='suspended': denied.add(address)
    else: denied.discard(address)
    atomic(CONFIG/'nuvomailo-deny',''.join(item+':x\n' for item in sorted(denied)),0o644)
    # Node-local fixed paths. Deny DB precedes ordinary passdb; no password is changed/deleted.
    atomic('/etc/dovecot/nuvomailo-deny',(CONFIG/'nuvomailo-deny').read_text(),0o644)
    deferred={line.split()[0] for line in lines(CONFIG/'nuvomailo-inbound') if line.strip()}
    if target.get('inboundPolicy','accept')=='defer': deferred.add(address)
    else: deferred.discard(address)
    policy=''.join(item+' 450 4.2.1 Mailbox temporarily unavailable\n' for item in sorted(deferred))
    atomic(CONFIG/'nuvomailo-inbound',policy,0o644)
    atomic('/etc/postfix/nuvomailo-inbound',policy,0o644)
    run(['postfix','reload'])
    run(['doveadm','reload'])
    if target['status']=='suspended':
        # Existing IMAP sessions must not retain access after a future-login deny.
        subprocess.run(['doveadm','kick',address],capture_output=True,timeout=10)
    started=time.monotonic()
    deadline=started+25
    stable_since=None
    while time.monotonic()<deadline:
        current=inspect(target)
        matches=current['status']==target['status'] and current['quotaMb']==target['quotaMb'] and ('inboundPolicy' not in target or current.get('inboundPolicy')==target['inboundPolicy'])
        if matches:
            if stable_since is None: stable_since=time.monotonic()
            # The FILE watcher may still be applying a previous captured snapshot.
            # Lab interval is 1s: require settling plus repeated independent observations.
            if time.monotonic()-started>=4 and time.monotonic()-stable_since>=2: return {'status':'applied'}
        else: stable_since=None
        time.sleep(0.25)
    raise Denied('STATE_MISMATCH',503)

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)
    def log_message(self,*args): pass
    def do_POST(self):
        code=200
        try:
            _,uid,gid=struct.unpack('3i',self.connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
            if uid!=1000 or gid!=3000: raise Denied('WORKER_IDENTITY_REQUIRED',403)
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN): raise Denied('UNAUTHORIZED',401)
            if self.path not in ['/v1/inspect','/v1/ensure','/v1/credential','/v1/routing','/v1/usage']: raise Denied('OPERATION_NOT_ALLOWED',404)
            size=int(self.headers.get('Content-Length','0'))
            if size<1 or size>(32768 if self.path=='/v1/routing' else 4096): raise Denied('INVALID_REQUEST',400)
            target=validate_operation(self.path,json.loads(self.rfile.read(size)))
            # Node-wide lock protects shared account/quota files as well as per-mailbox revisions.
            BRIDGE.sendall((json.dumps({'operation':self.path,'target':target})+'\n').encode())
            reply=json.loads(BRIDGE_READER.readline(8192))
            code,body=reply['code'],reply['body']
        except Denied as error: code=error.status;body={'error':error.code}
        except (ValueError,TypeError,json.JSONDecodeError): code=400;body={'error':'INVALID_REQUEST'}
        except Exception: code=503;body={'error':'PROVIDER_UNAVAILABLE'}
        # Never log headers, bodies, address, token, exception text or provider output.
        print(json.dumps({'event':'management_request','code':code,'result':body.get('error','ok')}),flush=True)
        encoded=json.dumps(body).encode()
        self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers()
        try: self.wfile.write(encoded)
        except (BrokenPipeError,ConnectionResetError): pass

if __name__=='__main__':
    os.umask(0o077)
    Path(SOCKET).parent.mkdir(exist_ok=True)
    os.chown(Path(SOCKET).parent,0,3000);os.chmod(Path(SOCKET).parent,0o750)
    if Path(SOCKET).exists(): Path(SOCKET).unlink()
    with socketserver.UnixStreamServer(SOCKET,Handler) as server:
        os.chown(SOCKET,0,3000);os.chmod(SOCKET,0o660)
        parent,child=socket.socketpair()
        helper_pid=os.getpid()
        if os.fork()==0:
            parent.close()
            BRIDGE=child
            BRIDGE_READER=child.makefile('rb')
            os.setgroups([]);os.setgid(3000);os.setuid(3001)
            if ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)!=0: os._exit(1)
            if os.getppid()!=helper_pid: os._exit(1)
            print(json.dumps({'event':'socket_service_ready','uid':os.getuid(),'gid':os.getgid()}),flush=True)
            server.serve_forever()
            os._exit(0)
        child.close()
        server.server_close()
        reader=parent.makefile('rb')
        # Privileged LAB helper has only an inherited channel to its dedicated child.
        # It independently validates every operation/target; no executable/path RPC.
        for raw in iter(lambda:reader.readline(65536),b''):
            try:
                request=json.loads(raw)
                if set(request)!={'operation','target'} or request['operation'] not in ['/v1/inspect','/v1/ensure','/v1/credential','/v1/routing','/v1/usage']: raise Denied('OPERATION_NOT_ALLOWED',400)
                target=validate_operation(request['operation'],request['target'])
                with open(STATE/'management.lock','a') as lock:
                    fcntl.flock(lock,fcntl.LOCK_EX)
                    body=usage(target) if request['operation']=='/v1/usage' else ensure_routing(target) if request['operation']=='/v1/routing' else ensure_credential(target) if request['operation']=='/v1/credential' else inspect(target) if request['operation']=='/v1/inspect' else ensure(target)
                code=200
            except Denied as error: code=error.status;body={'error':error.code}
            except Exception: code=503;body={'error':'PROVIDER_UNAVAILABLE'}
            parent.sendall((json.dumps({'code':code,'body':body})+'\n').encode())
