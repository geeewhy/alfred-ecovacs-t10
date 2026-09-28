#!/usr/bin/env python3
"""Enable authenticated USB/Wi-Fi ADB; install boot persistence by default."""
import argparse,hashlib,pathlib,subprocess,sys,time
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot,adb,CONFIG

def run(name,*args):subprocess.run([sys.executable,str(ROOT/'setup'/name),*args],check=True)
def wait_usb(limit=90):
    # One-second observations, grouped in batches of at most five.
    for batch in range((limit+4)//5):
        for _ in range(5):
            if CONFIG['usb_serial']+'\tdevice' in adb('devices',timeout=2):return Robot(CONFIG['usb_serial'])
            time.sleep(1)
        print('Waiting for robot boot / USB...',flush=True)
    raise RuntimeError('Robot did not return over USB; no further writes attempted')
def wait_normal_access(limit=90):
    """Normal boot proves the writable hook through persistent Wi-Fi ADB."""
    address=CONFIG['wifi_address']+':5555'
    for batch in range((limit+4)//5):
        for _ in range(5):
            devices=adb('devices',timeout=2)
            if CONFIG['usb_serial']+'\tdevice' in devices:return Robot(CONFIG['usb_serial'])
            try:adb('connect',address,timeout=2)
            except Exception:pass
            if address+'\tdevice' in adb('devices',timeout=2):return Robot(address)
            time.sleep(1)
        print('Waiting for normal boot / persistent Wi-Fi ADB...',flush=True)
    raise RuntimeError('Robot did not return through persistent ADB after normal boot')
def reboot(robot):
    try:robot.shell('sync; reboot',timeout=3)
    except Exception:pass  # Expected transport loss; verify boot ID afterwards.

def capture_access_diagnostics(robot,phase):
    """Keep evidence across daemon restarts, which can erase the useful logs."""
    directory=ROOT/'artifacts/setup';directory.mkdir(parents=True,exist_ok=True)
    command='''id
cat /sys/class/udc/*/state
cat /sys/devices/platform/soc/b2000000.usb/b2000000.dwc3/role
pidof adbd
for file in /tmp/alfred-enable.log /tmp/alfred-adb.log /tmp/adb-net.log; do
    echo "$file"
    tail -80 "$file" 2>/dev/null
done
true'''
    path=directory/(time.strftime('%Y%m%d-%H%M%S')+'-'+phase+'.log')
    path.write_text(robot.shell(command))
    print('ADB diagnostics saved: '+str(path),flush=True)

def ensure_access():
    robot=Robot()
    capture_access_diagnostics(robot,'before')
    robot.shell('mkdir -p /data/alfred; test -s /data/misc/adb/adb_keys')
    robot.upload(ROOT/'setup/rolling_log.py','/data/alfred/rolling_log.py')
    robot.upload(ROOT/'setup/adb_supervisor.py','/data/alfred/adb_supervisor.py')
    robot.upload(ROOT/'setup/adb-start.sh','/data/alfred/adb-start.sh')
    robot.shell('chmod 700 /data/alfred/adb-start.sh; sh -n /data/alfred/adb-start.sh')
    # Initialization must handle an existing TCP-only daemon. Detach the restart
    # and wait for it to exit before configuring the USB gadget.
    state=robot.shell('cat /sys/class/udc/*/state')
    if 'configured' not in state:
        robot.upload(ROOT/'setup/restart_adb.py','/data/alfred/restart_adb.py')
        robot.shell('python /data/alfred/restart_adb.py usb')
        for batch in range(2):
            for _ in range(5):
                devices=adb('devices')
                if CONFIG['usb_serial']+'\tdevice' in devices:break
                time.sleep(1)
            if CONFIG['usb_serial']+'\tdevice' in adb('devices'):break
            print('USB not ready; checking guarded TCP fallback.',flush=True)
    # Reconnect TCP if the restart replaced that transport.
    devices=adb('devices')
    address=CONFIG['wifi_address']+':5555'
    if address+'\toffline' in devices:adb('disconnect',address)
    try:adb('connect',address,timeout=3)
    except Exception:pass
    print('ADB transport state: '+adb('devices').strip(),flush=True)
    try:
        robot=Robot()
        if 'uid=0(root)' not in robot.shell('id'):
            raise RuntimeError('ADB shell is not root')
        capture_access_diagnostics(robot,'after')
    except Exception as exc:
        raise RuntimeError('ADB restart did not produce a verified root connection; '
                           'persistence was not attempted. See artifacts/setup diagnostics.') from exc

def persist():
    robot=Robot();boot=robot.shell('cat /proc/sys/kernel/random/boot_id').strip()
    rc=robot.shell('cat /etc/rc.conf')
    image=ROOT/'artifacts/firmware/rootfs-autostart-1.11.0.squashfs'
    expected=hashlib.md5(image.read_bytes()).hexdigest()
    if '!autostart.sh' not in rc and robot.shell('cat /sys/class/ubi/ubi0/mtd_num').strip()=='5':
        print('Boot autostart already enabled; updating managed ADB script.',flush=True)
    else:
        run('verify_boot_image.py')
    robot.shell('mkdir -p /data/alfred /data/autostart; test -s /data/misc/adb/adb_keys')
    # Remove only our failed experimental recovery hook, never unrelated user hooks.
    hook=robot.shell('cat /data/autostart/recovery.sh 2>/dev/null || true')
    if hook:
        if 'alfred/adb-start.sh' not in hook:raise RuntimeError('Unrecognized recovery hook; refusing overwrite')
        robot.shell('rm /data/autostart/recovery.sh')
    robot.upload(ROOT/'setup/rolling_log.py','/data/alfred/rolling_log.py')
    robot.upload(ROOT/'setup/adb_supervisor.py','/data/alfred/adb_supervisor.py')
    robot.upload(ROOT/'setup/adb-start.sh','/data/alfred/adb-start.sh')
    robot.shell('chmod 700 /data/alfred/adb-start.sh; sh -n /data/alfred/adb-start.sh; ln -sf /data/alfred/adb-start.sh /data/autostart/alfred.sh; sync')
    if '!autostart.sh' in rc:
        # Require working USB before selecting recovery (recovery Wi-Fi is not assumed).
        if CONFIG['usb_serial']+'\tdevice' not in adb('devices'):
            raise RuntimeError('Connect the working USB cable before persistence installation. Temporary Wi-Fi ADB remains available.')
        staged=robot.shell('md5sum /data/alfred/rootfs-autostart.squashfs 2>/dev/null || true',timeout=30).split()
        if not staged or staged[0]!=expected:run('stage_image.py')
        robot.shell('ubi_atomic_update_leb /dev/ubi2_0 -i boot_mode2 -n 0; sync')
        reboot(robot)
        # Ensure disappearance before accepting the next USB device instance.
        for _ in range(5):
            if CONFIG['usb_serial']+'\tdevice' not in adb('devices'):break
            time.sleep(1)
        robot=wait_usb()
        if robot.shell('cat /sys/class/ubi/ubi0/mtd_num').strip()!='6':raise RuntimeError('Recovery boot not confirmed; no flash')
        run('flash_prepared.py')
    elif robot.shell('cat /sys/class/ubi/ubi0/mtd_num').strip()=='6':
        run('flash_prepared.py')
    reboot(robot)
    for _ in range(5):
        if CONFIG['usb_serial']+'\tdevice' not in adb('devices'):break
        time.sleep(1)
    robot=wait_normal_access()
    assert robot.shell('cat /proc/sys/kernel/random/boot_id').strip()!=boot,'Reboot not verified'
    assert robot.shell('cat /sys/class/ubi/ubi0/mtd_num').strip()=='5','Not normal boot'
    assert 'uid=0(root)' in robot.shell('id')
    assert '!autostart.sh' not in robot.shell('cat /etc/rc.conf')
    print('Root ADB and writable autostart hook verified after normal boot.',flush=True)
    for _ in range(5):
        try:
            adb('connect',CONFIG['wifi_address']+':5555',timeout=2)
            if 'uid=0(root)' in Robot(CONFIG['wifi_address']+':5555').shell('id',timeout=2):
                print('SUCCESS: persistent Wi-Fi root ADB and writable autostart verified after reboot.',flush=True);return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('Normal boot verified; persistent Wi-Fi ADB is not reachable. Check robot DHCP address.')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--no-persist',action='store_true',help='Temporary ADB only; no rootfs update or reboot')
    p.add_argument('--manual-join',action='store_true')
    a=p.parse_args()
    try:robot=Robot();assert 'uid=0(root)' in robot.shell('id')
    except Exception:run('recover_adb.py','--run',*(['--manual-join'] if a.manual_join else []))
    ensure_access()
    if a.no_persist:print('Temporary authenticated ADB enabled.');return
    persist()
if __name__=='__main__':main()
