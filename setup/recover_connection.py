#!/usr/bin/env python3
"""Catch the next USB recovery boot, remove experimental restart hook."""
import subprocess,time,os,pathlib
E=dict(os.environ,ADB_LIBUSB='0');serial='ZJ2116C14F5F931933B'
# Event-driven ADB wait, supervised by this process; no Wi-Fi switching.
p=subprocess.Popen(['adb','-s',serial,'wait-for-device'],env=E)
p.wait()  # Detached event wait; survives until the user physically reboots.
cmd="rm -f /data/autostart/recovery.sh; pkill -f '^/bin/sh /data/autostart/recovery.sh' ; cat /sys/class/ubi/ubi0/mtd_num"
r=subprocess.run(['adb','-s',serial,'shell',cmd],env=E,capture_output=True,text=True,timeout=5)
print(r.stdout,r.stderr,flush=True)
