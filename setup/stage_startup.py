#!/usr/bin/env python3
import pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot
r=Robot()
r.shell('mkdir -p /data/alfred /data/autostart; test ! -e /data/autostart/alfred.sh; test ! -e /data/autostart/recovery.sh')
for name,dest in [('rolling_log.py','/data/alfred/rolling_log.py'),('adb-start.sh','/data/alfred/adb-start.sh')]:
    r.upload(ROOT/'setup'/name,dest);r.shell('chmod 700 '+dest)
    if name.endswith('.sh'):r.shell('sh -n '+dest)
r.shell('ln -s /data/alfred/adb-start.sh /data/autostart/alfred.sh; sync')
print('Startup files staged; normal boot hook is not enabled yet.')
