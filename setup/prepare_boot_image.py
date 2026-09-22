#!/usr/bin/env python3
"""Build a metadata-preserving rootfs patch; does NOT write the robot."""
import hashlib,pathlib,shlex,subprocess
R=pathlib.Path(__file__).resolve().parents[1];D=R/'artifacts/firmware';D.mkdir(parents=True,exist_ok=True)
stock=R/'artifacts/backups/rootfs-stock-1.11.0.squashfs'
assert hashlib.md5(stock.read_bytes()).hexdigest()=='0d1e4559ecb9b7c662bf1db6733bc3b3'
pseudo=D/'rootfs.pseudo'
subprocess.run(['unsquashfs','-pf',str(pseudo),str(stock)],check=True,stdout=subprocess.DEVNULL)
rc=subprocess.check_output(['unsquashfs','-cat',str(stock),'etc/rc.conf'])
assert rc.count(b'!autostart.sh')==1
modified=rc.replace(b'!autostart.sh',b'autostart.sh');(D/'rc.conf').write_bytes(modified)
b=pseudo.read_bytes();lines=b.split(b'\n');matches=[i for i,s in enumerate(lines) if s.startswith(b'etc/rc.conf R ')]
assert len(matches)==1;i=matches[0];fields=lines[i].split()
# Keep original timestamp, permissions, uid/gid. All other pseudo records/data untouched.
lines[i]=b' '.join([fields[0],b'F',*fields[2:6]])+b' cat '+shlex.quote(str(D/'rc.conf')).encode()
patched=D/'patched.pseudo';patched.write_bytes(b'\n'.join(lines))
image=D/'rootfs-autostart-1.11.0.squashfs'
empty=D/'empty';empty.mkdir(exist_ok=True)
subprocess.run(['mksquashfs',str(empty),str(image),'-pf',str(patched),'-noappend','-comp','gzip','-b','131072','-no-progress','-root-time','1747103018','-root-mode','755','-root-uid','0','-root-gid','0','-no-xattrs'],check=True,stdout=(D/'build.log').open('w'))
assert subprocess.check_output(['unsquashfs','-cat',str(image),'etc/rc.conf'])==modified
assert image.stat().st_size<104882176
print(image);print('MD5',hashlib.md5(image.read_bytes()).hexdigest())
