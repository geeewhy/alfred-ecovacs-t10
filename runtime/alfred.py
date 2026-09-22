#!/usr/bin/env python3
"""Everyday tools for Alfred, an Ecovacs T10 Omni."""
import argparse,base64,hashlib,json,os,pathlib,shlex,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/'robot.json').read_text())
ENV=dict(os.environ,ADB_LIBUSB='0')
def adb(*args,timeout=15):
    return subprocess.run(['adb',*args],env=ENV,capture_output=True,timeout=timeout,check=True).stdout.decode(errors='replace').replace('\r\n','\n')
def choose():
    devices=adb('devices')
    if CONFIG['usb_serial']+'\tdevice' in devices:return CONFIG['usb_serial']
    addr=CONFIG['wifi_address']+':5555'
    if addr+'\toffline' in devices:adb('disconnect',addr)
    adb('connect',addr,timeout=3)
    if addr+'\tdevice' not in adb('devices'):raise RuntimeError('Robot unavailable or unauthorized')
    return addr
class Robot:
    def __init__(self,serial=None):self.serial=serial or choose()
    def shell(self,command,timeout=15):
        # Old adbd has no shell-v2 exit code: append and inspect our own marker.
        result=adb('-s',self.serial,'shell',command+'\nrc=$?; printf "\\n__ALFRED_RC=%s\\n" "$rc"',timeout=timeout)
        body,marker=result.rsplit('\n__ALFRED_RC=',1)
        if marker.strip()!='0':raise RuntimeError(body+'\nRemote exit '+marker.strip())
        return body
    def upload(self,source,dest):
        source=pathlib.Path(source);data=source.read_bytes();tmp=dest+'.b64';q=shlex.quote
        self.shell(': > '+q(tmp))
        encoded=base64.b64encode(data).decode()
        for i in range(0,len(encoded),1800):self.shell('printf %s '+q(encoded[i:i+1800])+' >> '+q(tmp))
        self.shell('base64 -d '+q(tmp)+' > '+q(dest)+' && rm '+q(tmp))
        digest=self.shell('md5sum '+q(dest)).split()[0]
        if digest!=hashlib.md5(data).hexdigest():raise RuntimeError('Upload checksum mismatch')
    def play(self,path):
        payload=json.dumps({'fileList':[{'path':path}],'audioType':3},separators=(',',':'))
        result=self.shell('netmon_ctl -s /tmp/audio_daemon.sock -j '+shlex.quote(payload))
        if json.loads(result)['ret']!='ok':raise RuntimeError(result)
        return result

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--serial')
    sub=p.add_subparsers(dest='action',required=True)
    sub.add_parser('status');sub.add_parser('connect')
    shell=sub.add_parser('shell');shell.add_argument('command',nargs=argparse.REMAINDER)
    say=sub.add_parser('say');say.add_argument('text');say.add_argument('--voice',default='Samantha');say.add_argument('--backend',choices=['mac','native'],default='mac')
    play=sub.add_parser('play');play.add_argument('file')
    volume=sub.add_parser('volume');volume.add_argument('percent',type=int,nargs='?')
    stock=sub.add_parser('stock');stock.add_argument('number',type=int)
    a=p.parse_args();robot=Robot(a.serial)
    if a.action=='connect':print(robot.serial)
    elif a.action=='status':print(robot.shell('id; cat /proc/sys/kernel/random/boot_id; cat /etc/fw.manifest; pidof adbd medusa deebot; cat /sys/class/udc/*/state'))
    elif a.action=='shell':
        if a.command:print(robot.shell(' '.join(a.command)))
        else:subprocess.run(['adb','-s',robot.serial,'shell'],env=ENV,check=True)
    else:
        from audio_engine import AudioEngine
        engine=AudioEngine(robot)
        if a.action=='say':result=engine.say(a.text,a.voice,a.backend)
        elif a.action=='play':result=engine.play(a.file)
        elif a.action=='volume':result=engine.volume(a.percent)
        else:result=engine.stock(a.number)
        print(result)
if __name__=='__main__':main()
