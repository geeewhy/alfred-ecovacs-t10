#!/usr/bin/env python3
"""Recover existing authenticated ADB through the robot's pairing AP.
Secrets are supplied through ECOVACS_RETURN_WIFI_PASSWORD, never written to disk.
Use --manual-join if macOS refuses programmatic association.
"""
import argparse,datetime,fcntl,getpass,json,os,pathlib,shlex,socket,subprocess,sys,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts/recovery';ART.mkdir(parents=True,exist_ok=True)
CFG=json.loads((ROOT/'robot.json').read_text())
ENV=dict(os.environ,ADB_LIBUSB='0')
def log(msg):print(datetime.datetime.now().isoformat(timespec='seconds'),msg,flush=True)
def command(args,timeout=10):return subprocess.run(args,capture_output=True,text=True,timeout=timeout)
def association_ok(result):
    text=(result.stdout+result.stderr).lower()
    return result.returncode==0 and not any(x in text for x in ('failed','error:','could not find','not associated'))
def ip():
    r=command(['/usr/sbin/ipconfig','getifaddr','en0'],2);return r.stdout.strip()
def on_robot():return ip().startswith('192.168.0.')
def home_connected():
    if not ip().startswith('192.168.1.'):return False
    return '192.168.1.1' in command(['/sbin/route','-n','get','default'],2).stdout
def connect_adb():
    try:
        probe=socket.create_connection((CFG['wifi_address'],5555),timeout=.5);probe.close()
        subprocess.run(['adb','connect',CFG['wifi_address']+':5555'],env=ENV,capture_output=True,timeout=3)
        r=subprocess.run(['adb','-s',CFG['wifi_address']+':5555','shell','id'],env=ENV,capture_output=True,text=True,timeout=3)
        return r.returncode==0 and 'uid=0(root)' in r.stdout
    except (OSError,subprocess.TimeoutExpired):return False

def rpc(text,timeout=1):
    key='x; '+text+'\n#'
    if len(key.encode())>195:raise ValueError('Command exceeds proven CGI buffer budget')
    req=urllib.request.Request('http://192.168.0.1:8888/cgi-bin/startFct',data=json.dumps({'td':'StartFactory','key':key}).encode(),headers={'Content-Type':'application/json'})
    op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(req,timeout=timeout) as r:return r.read(4096).decode(errors='replace')

def restore(home,secret):
    # Exactly one return attempt; do not kill a still-running association or retry it.
    r=command(['/usr/sbin/networksetup','-setairportnetwork','en0',home,secret],30)
    if not association_ok(r):raise RuntimeError('Home association command failed: '+r.stdout+r.stderr)
    for _ in range(5):
        if home_connected():log('HOME_RESTORED verified address and gateway');return
        time.sleep(1)
    raise RuntimeError('Home association reported success but address/gateway did not verify')

def guardian(home,secret,ready,done,until):
    # The sole owner of home restoration, independent of main process failures.
    while time.monotonic()<until:
        if ready.exists():break
        if done.exists():break
        time.sleep(.1)
    if ready.exists():
        until=min(until,float(ready.read_text())+3)
        while time.monotonic()<until and not done.exists():time.sleep(.1)
    restore(home,secret)

def recover(home,secret):
    identity=rpc('id; cat /sys/class/net/wlan0/address; test -s /data/misc/adb/adb_keys && echo KEY_PRESENT')
    if 'uid=0(root)' not in identity or CFG['mac_address'] not in identity or 'KEY_PRESENT' not in identity:
        raise RuntimeError('Robot identity or existing authorized key did not verify; no changes made')
    log('ROBOT_VERIFIED root, MAC, existing key')
    rpc('pidof adbd || env PROP_service.adb.tcp.port=5555 PROP_ro.adb.secure=1 /usr/sbin/adbd </dev/null >/tmp/adb-net.log 2>&1 &')
    for attempt in range(3):
        try:
            s=socket.create_connection(('192.168.0.1',5555),timeout=.3);s.close();break
        except OSError:
            if attempt==2:raise
            time.sleep(.1)
    log('ADB_LISTENER verified on robot AP')
    cfg=json.dumps({'from':'ap_event','ap_version':2,'ssid':home,'passphrase':secret},separators=(',',':'))
    result=rpc('netmon_ctl -s /tmp/wifi_daemon.sock -j '+shlex.quote(cfg))
    if json.loads(result).get('ret')!='ok':raise RuntimeError('Robot rejected home Wi-Fi configuration')
    log('ROBOT_WIFI configuration accepted')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--home',default='TurnOffTheWifi');p.add_argument('--ssid',default='ECOVACS_0150')
    p.add_argument('--run',action='store_true');p.add_argument('--manual-join',action='store_true')
    p.add_argument('--guardian',nargs=3,help=argparse.SUPPRESS)
    a=p.parse_args();secret=os.environ.get('ECOVACS_RETURN_WIFI_PASSWORD')
    if a.guardian:
        if not secret:raise RuntimeError('Guardian missing secret')
        guardian(a.home,secret,pathlib.Path(a.guardian[0]),pathlib.Path(a.guardian[1]),float(a.guardian[2]));return
    if not a.run:
        log('CHECK ONLY: no Wi-Fi switch. '+('Home network verified.' if home_connected() else 'Home network not verified.'))
        log('Run with --run; --manual-join lets you select the AP in the Wi-Fi menu.');return
    lock=(ART/'lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if not secret:secret=getpass.getpass('Home Wi-Fi password (not saved): ')
    if not home_connected() and not on_robot():raise RuntimeError('Start from home Wi-Fi or the robot setup network')
    if not on_robot() and connect_adb():log('ALREADY_CONNECTED root ADB verified; no Wi-Fi changes');return
    run=ART/datetime.datetime.now().strftime('%Y%m%d-%H%M%S');run.mkdir()
    ready,done=run/'connected',run/'done'
    # Manual mode gives time to select AP; time on AP is still at most four seconds.
    deadline=time.monotonic()+(60 if a.manual_join else 15)
    env=dict(os.environ,ECOVACS_RETURN_WIFI_PASSWORD=secret)
    with (run/'restore.log').open('w') as output:
        guard=subprocess.Popen([sys.executable,__file__,'--home',a.home,'--guardian',str(ready),str(done),str(deadline)],env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True)
    join=None;error=None
    try:
        if on_robot():log('Already on robot setup network')
        elif a.manual_join:log('Select '+a.ssid+' in the Mac Wi-Fi menu now; monitoring association.')
        else:
            join=subprocess.Popen(['/usr/sbin/networksetup','-setairportnetwork','en0',a.ssid],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        while time.monotonic()<deadline:
            if on_robot():break
            if join and join.poll() is not None:
                stdout,stderr=join.communicate()
                if not association_ok(subprocess.CompletedProcess([],join.returncode,stdout,stderr)):
                    raise RuntimeError('Mac refused AP association. Use --manual-join; no name guessing or retry. '+stdout+stderr)
            time.sleep(.2)
        else:raise RuntimeError('No robot-network address before deadline')
        ready.write_text(str(time.monotonic()))
        recover(a.home,secret)
    except Exception as exc:error=str(exc);log('RECOVERY_STOPPED '+error)
    finally:
        if join and join.poll() is None:join.terminate();join.wait(timeout=2)
        done.touch()
        guard.wait(timeout=40)
        log((run/'restore.log').read_text())
    if guard.returncode!=0:raise RuntimeError('Home restoration FAILED; see '+str(run/'restore.log'))
    if error:raise RuntimeError(error)
    for _ in range(5):
        if connect_adb():log('SUCCESS authenticated root ADB '+CFG['wifi_address']+':5555');return
        time.sleep(1)
    raise RuntimeError('Home restored, but robot ADB is not yet reachable. No success claimed.')
if __name__=='__main__':main()
