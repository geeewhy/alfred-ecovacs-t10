#!/usr/bin/env python
"""Read native sleep state through RobotManage; never changes robot state."""
from __future__ import print_function
import socket,struct,xmlrpclib,json
from motor_snapshot import read,exact,MASTER
SERVICE='/task/RobotManage'
def header(s,fields):
    body=b''.join(struct.pack('<I',len(x))+x.encode() for x in fields)
    s.sendall(struct.pack('<I',len(body))+body)
    data=read(s);out={}
    while data:
        n=struct.unpack('<I',data[:4])[0];k,v=data[4:4+n].decode('utf-8','replace').split('=',1);out[k]=v;data=data[4+n:]
    return out
if __name__=='__main__':
    uri=xmlrpclib.ServerProxy(MASTER).lookupService('/alfred_sleep_probe',SERVICE)[2]
    address=uri.split('://')[1].rstrip('/');host,port=address.rsplit(':',1)
    s=socket.create_connection((host,int(port)),2)
    meta=header(s,['callerid=/alfred_sleep_probe','service='+SERVICE,'md5sum=*','probe=1']);s.close()
    print(json.dumps({'service':meta}))
    # Firmware service is uint8 managetype -> uint32 response, unlike stale Python stubs.
    md5="cfd9e920d932894ddac5afdaed914536"
    if meta.get('md5sum')!=md5:raise RuntimeError('Service definition mismatch; no request sent')
    s=socket.create_connection((host,int(port)),2)
    header(s,['callerid=/alfred_sleep_probe','service='+SERVICE,'md5sum='+md5,'persistent=0'])
    s.sendall(struct.pack('<IB',1,1))
    success=exact(s,1);data=read(s);s.close()
    print(json.dumps({'success':ord(success),'sleeping':struct.unpack('<I',data)[0]}))
