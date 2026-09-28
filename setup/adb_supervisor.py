#!/usr/bin/python
"""Restart a failed authenticated adbd without rebooting the robot (Python 2)."""
import fcntl,os,signal,subprocess,time
from rolling_log import append,run
ROOT='/data/alfred'
DISABLED=ROOT+'/adb-supervisor.disabled'
LOG=ROOT+'/logs/adb-supervisor.log'

def daemon_pids():
    found=[]
    for name in os.listdir('/proc'):
        if not name.isdigit():continue
        try:
            if open('/proc/'+name+'/comm').read().strip()=='adbd':found.append(int(name))
        except IOError:pass
    return found

def tick(pids,disabled,start):
    if disabled:return False
    if not pids:start();return True
    return False

def main():
    if os.fork():return
    os.setsid();signal.signal(signal.SIGHUP,signal.SIG_IGN)
    if os.fork():os._exit(0)
    fd=os.open('/dev/null',os.O_RDWR)
    for target in (0,1,2):os.dup2(fd,target)
    if fd>2:os.close(fd)
    lock=open(ROOT+'/adb-supervisor.lock','w')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except IOError:os._exit(0)
    append(LOG,'START boot='+open('/proc/sys/kernel/random/boot_id').read().strip())
    last_report=0
    def start():
        if not os.path.isfile('/data/misc/adb/adb_keys') or os.path.getsize('/data/misc/adb/adb_keys')==0:
            append(LOG,'Missing authorization keys; refusing start');return
        append(LOG,'adbd absent; restarting authenticated TCP daemon')
        run(ROOT+'/logs/adb.log',['env','PROP_service.adb.tcp.port=5555','PROP_ro.adb.secure=1','/usr/sbin/adbd'])
    while not os.path.exists(DISABLED):
        try:
            pids=daemon_pids();tick(pids,os.path.exists(DISABLED),start)
            if time.time()-last_report>=60:
                counts=[(p,len(os.listdir('/proc/%d/fd'%p))) for p in pids]
                append(LOG,'HEALTH pids_fds=%s uptime=%s'%(counts,open('/proc/uptime').read().strip()));last_report=time.time()
        except Exception as error:append(LOG,'ERROR '+str(error))
        time.sleep(5)
    append(LOG,'Disabled; exiting')

if __name__=='__main__':main()
