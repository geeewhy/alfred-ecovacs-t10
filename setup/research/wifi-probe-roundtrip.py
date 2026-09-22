#!/usr/bin/env python3
"""Bounded local robot access: one switch back starts four seconds after launch.
Wi-Fi association itself may take longer. No retries or competing restoration.
"""
import argparse,datetime,json,os,pathlib,subprocess,sys,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]/'artifacts/wifi'
ROOT.mkdir(parents=True,exist_ok=True)

def log(msg): print(datetime.datetime.now().isoformat(timespec='milliseconds'),msg,flush=True)
def address():
    try:return subprocess.check_output(['/usr/sbin/ipconfig','getifaddr','en0'],text=True,stderr=subprocess.DEVNULL,timeout=.4).strip()
    except Exception:return ''
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--home',required=True);p.add_argument('--robot',default='ECOVACS_150')
    p.add_argument('--network-adb',action='store_true');p.add_argument('--command-file');p.add_argument('--run',action='store_true');p.add_argument('--enable-adb',action='store_true')
    p.add_argument('--restore-at',type=float,help=argparse.SUPPRESS)
    a=p.parse_args()
    if a.home==a.robot:p.error('Home must differ from robot')
    if a.restore_at is not None:
        # Allow association to finish, then allow at most four seconds on robot.
        while time.monotonic()<a.restore_at:
            if address().startswith('192.168.0.'):
                time.sleep(3)
                break
            time.sleep(.1)
        log('Single home association begins')
        # Do not kill association early or launch concurrent retries.
        password=os.environ.get('ECOVACS_RETURN_WIFI_PASSWORD')
        if not password:raise RuntimeError('Missing return Wi-Fi password')
        r=subprocess.run(['/usr/sbin/networksetup','-setairportnetwork','en0',a.home,password],capture_output=True,text=True,timeout=30)
        output=r.stdout+r.stderr
        if r.returncode or 'failed' in output.lower() or 'error:' in output.lower():
            log('HOME RECONNECT FAILED: '+output);return
        for _ in range(20):
            if address().startswith('192.168.1.'):
                log('HOME RECONNECT VERIFIED: home subnet acquired');return
            time.sleep(.25)
        log('HOME RECONNECT UNVERIFIED: home address not acquired');return
    if not a.run:log('DRY RUN: four-second switch-back; one association each way; '+('temporary ADB startup' if a.enable_adb else 'read-only probe'));return
    if not os.environ.get('ECOVACS_RETURN_WIFI_PASSWORD'):p.error('ECOVACS_RETURN_WIFI_PASSWORD is required before any Wi-Fi switch')
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    with (ROOT/f'wifi-roundtrip-{stamp}.log').open('a',buffering=1) as f:
        sys.stdout=f;sys.stderr=f
        deadline=time.monotonic()+12
        subprocess.Popen([sys.executable,str(pathlib.Path(__file__).resolve()),'--home',a.home,'--restore-at',str(deadline)],stdin=subprocess.DEVNULL,stdout=f,stderr=f,start_new_session=True)
        log('Fallback armed; joining robot')
        join=subprocess.Popen(['/usr/sbin/networksetup','-setairportnetwork','en0',a.robot],stdout=f,stderr=f)
        try:
            while time.monotonic()<deadline-.6:
                if address().startswith('192.168.0.'):
                    if a.network_adb:
                        import network_adb
                        network_adb.run(urllib.request.build_opener(urllib.request.ProxyHandler({})),a.home,log)
                        break
                    cmd='printf ECOVACS_DIAG_BEGIN; id; cat /sys/devices/platform/soc/b2000000.usb/b2000000.dwc3/role; printf ECOVACS_DIAG_END'
                    if a.enable_adb:
                        cmd='id; /etc/rc.d/adbd.sh start >/tmp/adb-start.log 2>&1 &'
                    if a.command_file:cmd=pathlib.Path(a.command_file).read_text().strip()
                    data=json.dumps({'td':'StartFactory','key':'x; '+cmd+'; #'}).encode()
                    # Background launch already ends with &, so avoid invalid &; syntax.
                    if a.enable_adb:data=json.dumps({'td':'StartFactory','key':'x; '+cmd+' #'}).encode()
                    if len(json.loads(data)['key'].encode())>195:raise ValueError('Command exceeds CGI buffer budget')
                    req=urllib.request.Request('http://192.168.0.1:8888/cgi-bin/startFct',data=data,headers={'Content-Type':'application/json'})
                    op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with op.open(req,timeout=1.5) as r:result=r.read(8192).decode(errors='replace')
                    (ROOT/f'wifi-probe-{stamp}.txt').write_text(result);log('Response: '+result);break
                time.sleep(.1)
            else:log('No robot subnet within window; probe skipped')
        except Exception as e:log('Probe: '+repr(e))
        finally:
            # End only the outbound command before fallback; never interrupt home association.
            if join.poll() is None and not address().startswith('192.168.0.'):join.terminate()
            log('Probe complete; sole fallback owns restoration')
if __name__=='__main__':main()
