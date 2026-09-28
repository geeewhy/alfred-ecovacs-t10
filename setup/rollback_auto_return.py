#!/usr/bin/env python3
"""Bounded reconnect and rollback of the contact-return policy and legacy overlay; no restarts."""
import os,subprocess,time,json,pathlib
root=pathlib.Path(__file__).resolve().parents[1];config=json.loads((root/'robot.json').read_text());env=dict(os.environ,ADB_LIBUSB='0');address=config['wifi_address']+':5555'
stop=time.monotonic()+120
while time.monotonic()<stop:
 try:
  listing=subprocess.run(['adb','devices'],env=env,capture_output=True,text=True,timeout=2).stdout
  serial=next((s for s in (config['usb_serial'],address) if s+'\tdevice' in listing),None)
  if serial:
   command="rm -f /data/alfred/firmware/no-contact-return.enabled; if grep -q ' /usr/lib/node/liberos_node_job_schedule.so ' /proc/mounts; then umount /usr/lib/node/liberos_node_job_schedule.so; fi; if [ -f /data/alfred/firmware/no-contact-return-live.enabled ]; then python /data/alfred/firmware_policy.py disable || exit 1; fi; sha256sum /usr/lib/node/liberos_node_job_schedule.so"
   r=subprocess.run(['adb','-s',serial,'shell',command],env=env,capture_output=True,text=True,timeout=4)
   if r.returncode==0 and r.stdout.rstrip().endswith('/usr/lib/node/liberos_node_job_schedule.so') and '41c8816113c3045e38934cd614b6cf4a304f7717086c31ae637c8ed60a1bf475' in r.stdout:
    print('Stock contact-return policy restored; boot suppression disabled. No process restart requested.',flush=True);break
  else:
   subprocess.run(['adb','connect',address],env=env,capture_output=True,timeout=1)
 except subprocess.TimeoutExpired:pass
 time.sleep(1)
else:raise SystemExit('Robot remains unreachable; rollback not applied.')
