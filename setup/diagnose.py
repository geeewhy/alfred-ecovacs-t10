#!/usr/bin/env python3
import pathlib,sys,socket,subprocess
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'runtime'))
from alfred import adb,CONFIG
print(adb('devices','-l'))
for port in (5555,8888):
 s=socket.socket();s.settimeout(.5);print(port,s.connect_ex((CONFIG['wifi_address'],port)));s.close()
print(adb('connect',CONFIG['wifi_address']+':5555',timeout=3))
r=subprocess.run(['ioreg','-p','IOUSB','-w','0'],capture_output=True,text=True)
print('\n'.join(x for x in r.stdout.splitlines() if 'xj3' in x or 'Hub' in x))
