#!/usr/bin/python
# On-device Python 2 compatible restart, detached from the ADB parent.
import os,signal,time,subprocess,socket,sys
mode=sys.argv[1] if len(sys.argv)>1 else 'usb'
if mode not in ('start','usb'):raise SystemExit(2)
if os.fork():os._exit(0)
os.setsid();signal.signal(signal.SIGHUP,signal.SIG_IGN)
if os.fork():os._exit(0)
fd=os.open('/dev/null',os.O_RDONLY);os.dup2(fd,0);os.close(fd)
fd=os.open('/tmp/alfred-enable.log',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
os.dup2(fd,1);os.dup2(fd,2);os.close(fd)
def listening():
    s=socket.socket();s.settimeout(.3)
    try:return s.connect_ex(('127.0.0.1',5555))==0
    finally:s.close()
# Arm a separate TCP recovery process BEFORE stopping the existing daemon.
if os.fork()==0:
    # Give the primary path enough time to stop the old daemon, rebuild
    # FunctionFS, and bind the UDC before restoring TCP-only access.
    time.sleep(10)
    if not listening():
        subprocess.call(['killall','adbd'])
        time.sleep(.3)
        env=dict(os.environ);env['PROP_service.adb.tcp.port']='5555';env['PROP_ro.adb.secure']='1'
        subprocess.Popen(['/usr/sbin/adbd'],env=env,close_fds=True)
    os._exit(0)
time.sleep(.5)
subprocess.call(['killall','adbd'])
for i in range(5):
    if subprocess.call(['pidof','adbd'],stdout=open('/dev/null','w'))!=0:break
    time.sleep(1)
subprocess.call(['/bin/sh','/data/alfred/adb-start.sh',mode])
