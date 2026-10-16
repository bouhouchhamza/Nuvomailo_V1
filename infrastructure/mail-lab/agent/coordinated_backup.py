"""Operator-only synthetic offline snapshot. Native CMS AEAD, never a remote agent RPC."""
import hashlib,io,json,os,re,stat,subprocess,sys,tarfile,time
from pathlib import Path

COMPONENTS=['config','mail','state','agent-state','credential-vault','broker-auth','worker-auth','public-trust']
os.umask(0o077)
def command(args):
    result=subprocess.run(args,capture_output=True,timeout=120)
    if result.returncode:raise RuntimeError('NATIVE_OPERATION_FAILED')
    return result.stdout
def archive_path(identifier):
    if not re.fullmatch(r'[0-9a-f-]{36}',identifier):raise RuntimeError('INVALID_SNAPSHOT_ID')
    return Path('/archives')/(identifier+'.cms')
def private_key():
    key=Path('/keys/backup.pem');cert=Path('/keys/backup.crt')
    if key.exists():
        if not cert.exists():raise RuntimeError('INCOMPLETE_KEY_PAIR')
        return
    command(['openssl','req','-x509','-newkey','rsa:3072','-nodes','-keyout',str(key),'-out',str(cert),'-days','7','-subj','/CN=NuvomailoSyntheticBackup'])
    os.chmod(key,0o600)
def files(component):
    root=Path('/source')/component
    yield root,component
    for directory,dirs,names in os.walk(root,followlinks=False):
        base=Path(directory)
        if component=='agent-state' and base==root:dirs[:]=[name for name in dirs if name!='snapshots']
        for name in dirs+names:
            path=base/name
            if path.is_symlink():raise RuntimeError('SOURCE_LINK_REQUIRES_REVIEW')
        for name in dirs:yield base/name,component+'/'+str((base/name).relative_to(root))
        for name in names:
            path=base/name
            if stat.S_ISFIFO(path.stat().st_mode) or stat.S_ISSOCK(path.stat().st_mode):continue
            if not stat.S_ISREG(path.stat().st_mode):raise RuntimeError('SOURCE_SPECIAL_FILE')
            yield path,component+'/'+str(path.relative_to(root))
def decrypt(identifier):
    target=Path('/tmp/verified.tar')
    command(['openssl','cms','-decrypt','-binary','-inform','DER','-in',str(archive_path(identifier)),'-recip','/keys/backup.crt','-inkey','/keys/backup.pem','-out','/tmp/signed.cms'])
    command(['openssl','cms','-verify','-verify_retcode','-binary','-inform','DER','-in','/tmp/signed.cms','-nointern','-certfile','/keys/backup.crt','-CAfile','/keys/backup.crt','-no-CApath','-no-CAstore','-purpose','any','-out',str(target)])
    return target
def validate(handle):
    for member in handle.getmembers():
        parts=Path(member.name).parts
        if not parts or Path(member.name).is_absolute() or '..' in parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):raise RuntimeError('UNSAFE_ARCHIVE_ENTRY')
        if parts[0] not in COMPONENTS+['control-plane.dump','manifest.json']:raise RuntimeError('UNEXPECTED_COMPONENT')
def backup(identifier):
    private_key();output=archive_path(identifier)
    if output.exists():raise RuntimeError('SNAPSHOT_ALREADY_EXISTS')
    database=sys.stdin.buffer.read(8*1024*1024+1)
    if not database.startswith(b'PGDMP') or len(database)>8*1024*1024:raise RuntimeError('INVALID_DATABASE_DUMP')
    manifest={'databaseSha256':hashlib.sha256(database).hexdigest(),'files':{},'createdAt':time.time()}
    signer=subprocess.Popen(['openssl','cms','-sign','-binary','-stream','-nodetach','-outform','DER','-signer','/keys/backup.crt','-inkey','/keys/backup.pem'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    encrypt=subprocess.Popen(['openssl','cms','-encrypt','-binary','-stream','-aes-256-gcm','-outform','DER','-recip','/keys/backup.crt','-keyopt','rsa_padding_mode:oaep','-keyopt','rsa_oaep_md:sha256','-out',str(output)],stdin=signer.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    signer.stdout.close()
    try:
        with tarfile.open(fileobj=signer.stdin,mode='w|',dereference=True) as handle:
            info=tarfile.TarInfo('control-plane.dump');info.size=len(database);info.mode=0o600;handle.addfile(info,io.BytesIO(database))
            for component in COMPONENTS:
                for path,name in files(component):
                    if path.is_dir():handle.add(path,arcname=name,recursive=False);continue
                    digest=hashlib.file_digest(path.open('rb'),'sha256').hexdigest();manifest['files'][name]=digest
                    handle.add(path,arcname=name,recursive=False)
            encoded=json.dumps(manifest,sort_keys=True).encode();info=tarfile.TarInfo('manifest.json');info.size=len(encoded);info.mode=0o600;handle.addfile(info,io.BytesIO(encoded))
        signer.stdin.close()
        if signer.wait(timeout=120):raise RuntimeError('SIGNATURE_FAILED')
        if encrypt.wait(timeout=120):raise RuntimeError('ENCRYPTION_FAILED')
    finally:
        if signer.poll() is None:signer.kill()
        if encrypt.poll() is None:encrypt.kill()
    print(json.dumps({'encrypted':True,'snapshotId':identifier,'archiveBytes':output.stat().st_size,'files':len(manifest['files']),'databaseIncluded':True,'credentialVaultIncluded':True}))
def restore(identifier):
    for component in COMPONENTS:
        destination=Path('/target')/component
        if destination.is_symlink() or any(destination.iterdir()):raise RuntimeError('RESTORE_TARGET_NOT_EMPTY')
    path=decrypt(identifier) # Authenticate complete CMS before any extraction.
    with tarfile.open(path) as handle:
        validate(handle);manifest=json.load(handle.extractfile('manifest.json'))
        regular={member.name for member in handle.getmembers() if member.isfile() and Path(member.name).parts[0] in COMPONENTS}
        if not isinstance(manifest.get('files'),dict) or set(manifest['files'])!=regular:raise RuntimeError('INVALID_MANIFEST')
        for member in handle.getmembers():
            if Path(member.name).parts[0] in COMPONENTS:handle.extract(member,'/target')
        for name,digest in manifest['files'].items():
            if hashlib.file_digest((Path('/target')/name).open('rb'),'sha256').hexdigest()!=digest:raise RuntimeError('RESTORE_DIGEST_MISMATCH')
    credentials=Path('/target/agent-state/credentials.json');routing=Path('/target/agent-state/routing.json')
    proof={'credentials':json.loads(credentials.read_text()) if credentials.exists() else {},'routing':json.loads(routing.read_text()) if routing.exists() else {}}
    output=Path('/target/public-trust/recovery-proof.json');output.write_text(json.dumps(proof));os.chmod(output,0o644)
    print(json.dumps({'restoredIntoEmptyVolumes':True,'filesVerified':len(manifest['files']),'credentialVaultRestored':True}))
def database(identifier):
    with tarfile.open(decrypt(identifier)) as handle:
        validate(handle);manifest=json.load(handle.extractfile('manifest.json'));value=handle.extractfile('control-plane.dump').read()
        if hashlib.sha256(value).hexdigest()!=manifest['databaseSha256']:raise RuntimeError('DATABASE_DIGEST_MISMATCH')
        sys.stdout.buffer.write(value)
def tamper(identifier):
    data=bytearray(archive_path(identifier).read_bytes());data[len(data)//2]^=1;Path('/tmp/tampered.cms').write_bytes(data)
    result=subprocess.run(['openssl','cms','-decrypt','-binary','-inform','DER','-in','/tmp/tampered.cms','-recip','/keys/backup.crt','-inkey','/keys/backup.pem','-out','/tmp/rejected.tar'],capture_output=True,timeout=120)
    if result.returncode==0:raise RuntimeError('TAMPER_WAS_NOT_REJECTED')
    print(json.dumps({'authenticatedTamperRejected':True}))
try:
    mode,identifier=sys.argv[1:];{'backup':backup,'restore':restore,'database':database,'tamper':tamper}[mode](identifier)
except Exception as error:
    safe=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z_]{1,60}',str(error)) else 'COORDINATED_BACKUP_OPERATION_FAILED'
    print(json.dumps({'error':safe,'kind':type(error).__name__}),file=sys.stderr);sys.exit(1)
