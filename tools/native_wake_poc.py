#!/usr/bin/env python
"""Firmware 1.11 native WorkManage STOP or zero-motion remote wake probe."""
from __future__ import print_function
import socket,struct,xmlrpclib,json,sys,subprocess,time
from robot_sleep_state import header
from motor_snapshot import MASTER,read,exact
SERVICE='/task/WorkManage'
MD5='02b48ec9983e0e81cc0e264c502c304b'
def call(remote=False):
    address=xmlrpclib.ServerProxy(MASTER).lookupService('/alfred_wake_poc',SERVICE)[2].split('://')[1].rstrip('/')
    host,port=address.rsplit(':',1)
    s=socket.create_connection((host,int(port)),2)
    meta=header(s,['callerid=/alfred_wake_poc','service='+SERVICE,'md5sum=*','probe=1']);s.close()
    if meta.get('md5sum')!=MD5:raise RuntimeError('Firmware schema mismatch: '+repr(meta))
    # Live serializer: uint8 manage, uint8 work, string, WorkData.
    # Empty CleanWorkData: ten array lengths, theta, cleanmode (45 bytes).
    clean=b'\0'*45
    # ExtraWorkData: ids[], poses[], RemoteMove, tasktime, states[].
    extra=struct.pack('<IIBHhhII',0,0,2,0,0,0,0,0)
    payload=struct.pack('<BBI',0 if remote else 1,9 if remote else 7,0)+clean+extra
    s=socket.create_connection((host,int(port)),2)
    header(s,['callerid=/alfred_wake_poc','service='+SERVICE,'md5sum='+MD5,'persistent=0'])
    s.sendall(struct.pack('<I',len(payload))+payload)
    ok=exact(s,1);result=read(s);s.close()
    print(json.dumps({'action':'remote_stop' if remote else 'stop','success':ord(ok),'response':list(bytearray(result))}))
if __name__=='__main__':
    call('--remote' in sys.argv)
    for _ in range(5):
        time.sleep(1)
        output=subprocess.check_output(['python','/tmp/robot_sleep_state.py']);print(output)
        if '"sleeping": 0' in output:break
