#!/usr/bin/env python
"""Read-only motor/sensor ROS snapshot; run on the robot with Python 2."""
from __future__ import print_function
import socket, struct, threading, json, binascii
import xmlrpclib
socket.setdefaulttimeout(2)
MASTER='http://127.0.0.1:11311'
OUTPUT_LOCK=threading.Lock()
TOPICS=['/task/sleepstate','/task/WorkState','/power/Battery','/motor/MotorProtection','/motor/MotorCurrent','/power/ChargeState','/onOffInfo/OnOffInfo','/onOffInfo/RobotInvalidState','/alert/Alerts','/wheel/WheelDistanceReport','/wheel/SetWheelSpeed']
def exact(s,n):
    data=b''
    while len(data)<n:
        part=s.recv(n-len(data))
        if not part:raise IOError('closed')
        data+=part
    return data
def read(s):return exact(s,struct.unpack('<I',exact(s,4))[0])
def inspect(topic,publishers):
    result={'topic':topic,'publishers':publishers}
    s=None
    try:
        master=xmlrpclib.ServerProxy(MASTER)
        uri=master.lookupNode('/alfred_motor_snapshot',publishers[0])[2]
        proto=xmlrpclib.ServerProxy(uri).requestTopic('/alfred_motor_snapshot',topic,[['TCPROS']])[2]
        s=socket.create_connection((proto[1],proto[2]),2)
        fields=['callerid=/alfred_motor_snapshot','topic='+topic,'md5sum=*','tcp_nodelay=1']
        header=b''.join(struct.pack('<I',len(x))+x.encode() for x in fields)
        s.sendall(struct.pack('<I',len(header))+header)
        header=read(s);meta={}
        while header:
            n=struct.unpack('<I',header[:4])[0];key,value=header[4:4+n].decode('utf-8', 'replace').split('=',1);meta[key]=value;header=header[4+n:]
        result['definition']=meta.get('message_definition','')
        payload=read(s);result['hex']=binascii.hexlify(payload).decode()
        try:
            package,name=map(str,meta['type'].split('/'))
            cls=getattr(__import__(package+'.msg',fromlist=[name]),name)
            result['value']=str(cls().deserialize(payload))
        except Exception as error:result['decode_error']=str(error)
    except Exception as error:result['error']=str(error)
    finally:
        if s:s.close()
    with OUTPUT_LOCK:print(json.dumps(result))
if __name__=='__main__':
    pubs=dict(xmlrpclib.ServerProxy(MASTER).getSystemState('/alfred_motor_snapshot')[2][0])
    threads=[threading.Thread(target=inspect,args=(t,pubs.get(t,[]))) for t in TOPICS]
    for t in threads:t.start()
    for t in threads:t.join()
