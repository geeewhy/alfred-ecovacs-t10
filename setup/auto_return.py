#!/usr/bin/env python3
"""Manage the reversible live charging-contact return policy.

Build first: zig cc -target aarch64-linux-musl -Os -s -static
 setup/contact_return_patch.c -o artifacts/firmware-policy/contact-return-patch
`enable` suppresses contact-loss return; `disable` restores stock behavior.
"""
import pathlib,sys,shlex
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot
r=Robot();action=sys.argv[1] if len(sys.argv)>1 else 'status'
if action not in ('enable','disable','status','selftest'):raise SystemExit('Use enable, disable, status or selftest')
if action in ('enable','selftest'):
    r.upload(ROOT/'artifacts/firmware-policy/contact-return-patch','/data/alfred/contact-return-patch.new')
    r.shell('chmod 700 /data/alfred/contact-return-patch.new && mv /data/alfred/contact-return-patch.new /data/alfred/contact-return-patch')
    print(r.shell('/data/alfred/contact-return-patch selftest',timeout=5))
    if action=='selftest':sys.exit(0)
    r.upload(ROOT/'setup/firmware_policy.py','/data/alfred/firmware_policy.py')
    r.upload(ROOT/'setup/rolling_log.py','/data/alfred/rolling_log.py')
    r.upload(ROOT/'setup/adb-start.sh','/data/alfred/adb-start.sh')
    r.shell('sh -n /data/alfred/adb-start.sh && chmod 700 /data/alfred/adb-start.sh')
print(r.shell('python /data/alfred/firmware_policy.py '+action,timeout=5))
if action=='enable':
    # Reload only our policy supervisor so deployed policy revisions take effect.
    script="""import os,signal
for name in os.listdir('/proc'):
 if not name.isdigit():continue
 try:
  args=open('/proc/'+name+'/cmdline','rb').read().split(b'\\0')
  if len(args)==4 and args[1:3]==[b'/data/alfred/firmware_policy.py',b'supervise']:os.kill(int(name),signal.SIGTERM)
 except (IOError,OSError):pass
"""
    r.shell('python -c '+shlex.quote(script),timeout=5)
    r.shell('python /data/alfred/firmware_policy.py supervise',timeout=5)
