"""Restore lab snapshot only into empty, separately mounted fixture volumes."""
import json
import tarfile
from pathlib import Path
root=Path('/restore')
allowed=['tmp/docker-mailserver','var/mail','var/mail-state','var/lib/nuvomailo-agent']
for prefix in allowed:
    destination=root/prefix
    if any(destination.iterdir()): raise RuntimeError('RESTORE_TARGET_NOT_EMPTY')
archive=sorted(Path('/source/snapshots').glob('lab-*.tar'))[-1]
with tarfile.open(archive) as handle:
    for member in handle.getmembers():
        name=member.name.rstrip('/')
        if '..' in Path(name).parts or Path(name).is_absolute() or not any(name==prefix or name.startswith(prefix+'/') for prefix in allowed): raise RuntimeError('UNSAFE_ARCHIVE_ENTRY')
        if member.issym() or member.islnk():
            # Do not extract links; reject instead of allowing target/path escape.
            raise RuntimeError('ARCHIVE_LINK_REQUIRES_REVIEW')
    handle.extractall(root)
print(json.dumps({'restoredIntoEmptyVolumes':True,'archiveBytes':archive.stat().st_size}))
