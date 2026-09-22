"""Temporary authenticated ADB plus user's requested home Wi-Fi provisioning."""
import base64,json,os,pathlib,time,urllib.request

def commands(home,password,pubkey):
    yield 'id; cat /sys/class/net/wlan0/address'
    yield ': > /tmp/mac-adb-key.b64'
    data=base64.b64encode(pubkey).decode()
    for i in range(0,len(data),100):
        yield "printf %s '"+data[i:i+100]+"' >> /tmp/mac-adb-key.b64"
    yield 'mkdir -p /data/misc/adb; base64 -d /tmp/mac-adb-key.b64 >> /data/misc/adb/adb_keys; chmod 600 /data/misc/adb/adb_keys'
    yield "killall adbd; env PROP_service.adb.tcp.port=5555 PROP_ro.adb.secure=1 /usr/sbin/adbd </dev/null >/tmp/adb-net.log 2>&1 &"
    yield 'pidof adbd; cat /tmp/adb-net.log'
    cfg=json.dumps({'from':'ap_event','ap_version':2,'ssid':home,'passphrase':password},separators=(',',':'))
    yield "netmon_ctl -s /tmp/wifi_daemon.sock -j '"+cfg.replace("'","'\"'\"'")+"'"

def run(op,home,log):
    pub=(pathlib.Path.home()/'.android/adbkey.pub').read_bytes().rstrip()+b'\n'
    cmds=list(commands(home,os.environ['ECOVACS_RETURN_WIFI_PASSWORD'],pub))
    for cmd in cmds:
        if len(('x; '+cmd+'\n#').encode())>195:raise ValueError('Command too long for CGI')
    start=time.monotonic()
    for i,cmd in enumerate(cmds):
        if time.monotonic()-start>2.8:raise TimeoutError('Four-second window; stopping before further commands')
        data=json.dumps({'td':'StartFactory','key':'x; '+cmd+'\n#'}).encode()
        req=urllib.request.Request('http://192.168.0.1:8888/cgi-bin/startFct',data=data,headers={'Content-Type':'application/json'})
        with op.open(req,timeout=.7) as r:result=r.read(8192).decode(errors='replace')
        log('Network ADB step '+str(i+1)+': '+result)
