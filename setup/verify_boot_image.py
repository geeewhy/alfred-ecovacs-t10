#!/usr/bin/env python3
"""Compare every file's metadata/content without extracting privileged nodes."""
import hashlib,pathlib,shlex,subprocess
D=pathlib.Path(__file__).resolve().parents[1]/'artifacts/firmware'
subprocess.run(['unsquashfs','-pf',str(D/'verify.pseudo'),str(D/'rootfs-autostart-1.11.0.squashfs')],check=True,stdout=subprocess.DEVNULL)
def parse(p):
    h,d=p.read_bytes().split(b'#\n# START OF DATA - DO NOT MODIFY\n#\n',1);r={}
    for line in h.decode().splitlines():
        v=shlex.split(line);name=v[0]
        if v[1]=='R':
            size,off=int(v[6]),int(v[7]);r[name]=(v[1:6],hashlib.sha256(d[off:off+size]).hexdigest())
        else:r[name]=v[1:]
    return r
old,new=map(parse,[D/'rootfs.pseudo',D/'verify.pseudo'])
diffs=sorted(k for k in old.keys()|new.keys() if old.get(k)!=new.get(k))
assert diffs==['etc/rc.conf'],diffs
assert old['etc/rc.conf'][0]==new['etc/rc.conf'][0]
print('Verified',len(old),'entries; only etc/rc.conf content differs. Metadata unchanged.')
