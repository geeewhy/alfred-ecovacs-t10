#!/usr/bin/env python3
"""Apply prepared rootfs ONLY from verified recovery; never runs during normal boot."""
import hashlib,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot
r=Robot();image=ROOT/'artifacts/firmware/rootfs-autostart-1.11.0.squashfs'
expected=hashlib.md5(image.read_bytes()).hexdigest()
assert r.shell('cat /sys/class/ubi/ubi0/mtd_num').strip()=='6','Must be in recovery root on physical MTD 6'
assert r.shell('md5sum /data/alfred/rootfs-autostart.squashfs',timeout=30).split()[0]==expected
# Recovery OTA reserves ubi4 for the normal system. Guard the mapping explicitly.
r.shell('test -d /sys/class/ubi/ubi4 || ubiattach /dev/ubi_ctrl -m 5 -d 4')
assert r.shell('cat /sys/class/ubi/ubi4/mtd_num').strip()=='5'
assert r.shell('cat /sys/class/ubi/ubi4_0/name').strip()=='rootfs'
assert 'ubi4' not in r.shell('cat /proc/mounts')
current=r.shell('md5sum /dev/ubi4_0',timeout=30).split()[0]
if current==expected:
    r.shell('ubi_atomic_update_leb /dev/ubi2_0 -i boot_mode1 -n 0; sync')
    print('Prepared image already installed; normal boot selected.');sys.exit(0)
assert current=='0d1e4559ecb9b7c662bf1db6733bc3b3','Unexpected installed rootfs'
print('Recovery and target verified; writing prepared normal rootfs.',flush=True)
r.shell('ubiupdatevol /dev/ubi4_0 /data/alfred/rootfs-autostart.squashfs; sync',timeout=180)
assert r.shell('md5sum /dev/ubi4_0',timeout=30).split()[0]==expected
r.shell('ubi_atomic_update_leb /dev/ubi2_0 -i boot_mode1 -n 0; sync')
print('Flash verified; normal boot selected. Reboot separately to validate.')
