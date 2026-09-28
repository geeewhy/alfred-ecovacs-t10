#!/usr/bin/env python
"""Reversible live T10 1.11.0 contact-return policy; no firmware restart.

The pinned contact-loss callback and contact-count return branch initiate
return jobs. Disabling those paths leaves charging telemetry and explicit return
intact. The disk library stays original; a boot supervisor reapplies per PID.
"""
from __future__ import print_function
import binascii,fcntl,hashlib,json,os,signal,subprocess,sys,time
TARGET='/usr/lib/node/liberos_node_job_schedule.so'
ROOT='/data/alfred/firmware'
FLAG=ROOT+'/no-contact-return-live.enabled'
HELPER='/data/alfred/contact-return-patch'
ORIGINAL='41c8816113c3045e38934cd614b6cf4a304f7717086c31ae637c8ed60a1bf475'
OFFSET=0x24590
BEFORE=b'\xff\x43\x08\xd1'
AFTER=b'\xc0\x03\x5f\xd6'
PATCHES=((OFFSET,BEFORE,AFTER),(0x2dad4,b'\xe0\x01\x00\x54',b'\x1f\x20\x03\xd5'))

def digest(data):return hashlib.sha256(data).hexdigest()
def build(data):
    # Offline guard/test only; never mounts or installs a modified library.
    if digest(data)!=ORIGINAL:raise RuntimeError('Unsupported firmware; refusing patch')
    for offset,before,after in PATCHES:
        if data[offset:offset+4]!=before:raise RuntimeError('Unsupported instruction')
        data=data[:offset]+after+data[offset+4:]
    return data

def loaded():
    result=[]
    for name in os.listdir('/proc'):
        if not name.isdigit():continue
        try:
            if b'/etc/conf/dxai_node.json' not in open('/proc/'+name+'/cmdline','rb').read():continue
            for line in open('/proc/'+name+'/maps'):
                parts=line.split()
                if len(parts)<6 or parts[-1]!=TARGET or 'x' not in parts[1]:continue
                low,high=[int(v,16) for v in parts[0].split('-')];offset=int(parts[2],16)
                if not offset<=OFFSET<offset+high-low:continue
                instructions=[]
                with open('/proc/'+name+'/mem','rb',0) as mem:
                    for at,before,after in PATCHES:
                        if not offset<=at<offset+high-low:raise RuntimeError('Patch outside executable mapping')
                        mem.seek(low+at-offset);instruction=mem.read(4)
                        instructions.append(binascii.hexlify(instruction).decode('ascii'))
                result.append({'pid':int(name),'inode':int(parts[4]),'instructions':instructions,'disabled':all(instructions[i]==binascii.hexlify(v[2]).decode('ascii') for i,v in enumerate(PATCHES))})
                break
        except (IOError,OSError):continue
    return result
def status():
    with open(TARGET,'rb') as source:sha=digest(source.read())
    processes=loaded()
    return {'enabled':os.path.exists(FLAG),'file_sha256':sha,'disk_original':sha==ORIGINAL,'processes':processes,'disabled_live':bool(processes) and all(p['disabled'] for p in processes)}
def apply(action):
    if action=='status':return status()
    if action not in ('enable','disable','boot'):raise ValueError('Use enable, disable, boot or status')
    if action=='boot' and not os.path.exists(FLAG):return status()
    if not os.path.isdir(ROOT):os.makedirs(ROOT,0o700)
    with open(ROOT+'/policy.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if action=='boot' and not os.path.exists(FLAG):return status()
        # Hash and inode check reject overlays, replaced firmware, and stale
        # process mappings. The native helper rechecks the live instruction.
        before=status();inode=os.stat(TARGET).st_ino
        if not before['disk_original']:raise RuntimeError('Unsupported/overlaid firmware; refusing live patch')
        for p in before['processes']:
            if p['inode']!=inode:raise RuntimeError('Firmware loaded from a different library inode')
            for value,spec in zip(p['instructions'],PATCHES):
                if value not in [binascii.hexlify(v).decode('ascii') for v in spec[1:]]:raise RuntimeError('Unexpected callback instruction')
        if action=='enable' and not before['processes']:raise RuntimeError('Firmware not available')
        desired=action!='disable'
        for p in before['processes']:
            if p['instructions']!=[binascii.hexlify(v[2 if desired else 1]).decode('ascii') for v in PATCHES]:subprocess.check_call([HELPER,str(p['pid']),'enable' if desired else 'disable'])
        after=status()
        if any(p['instructions']!=[binascii.hexlify(v[2 if desired else 1]).decode('ascii') for v in PATCHES] for p in after['processes']):raise RuntimeError('Live policy verification failed')
        if desired:
            fd=os.open(FLAG,os.O_CREAT|os.O_WRONLY,0o600);os.close(fd)
        elif os.path.exists(FLAG):os.unlink(FLAG)
        return status()
def supervise():
    if not os.path.exists(FLAG):return
    if os.fork():return
    os.setsid();signal.signal(signal.SIGHUP,signal.SIG_IGN)
    if os.fork():os._exit(0)
    fd=os.open('/dev/null',os.O_RDWR)
    for target in (0,1,2):os.dup2(fd,target)
    if fd>2:os.close(fd)
    lock=open(ROOT+'/supervisor.lock','a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except IOError:os._exit(0)
    from rolling_log import append
    previous=None
    while os.path.exists(FLAG):
        try:report=json.dumps(apply('boot'),sort_keys=True)
        except Exception as error:report='ERROR '+str(error)
        if report!=previous:append('/data/alfred/logs/firmware-policy.log',report);previous=report
        time.sleep(2)
if __name__=='__main__':
    action=sys.argv[1] if len(sys.argv)>1 else 'status'
    if action=='supervise':supervise()
    else:print(json.dumps(apply(action)))
