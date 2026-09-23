#!/usr/bin/env python
"""On-device bounded 20% forward test with passive ROS feedback capture."""
from __future__ import print_function
import httplib,json,socket,struct,threading,time,xmlrpclib,binascii
from motor_snapshot import exact,read,MASTER
LOCK=threading.Lock()
def report(data):
    with LOCK:print(json.dumps(data))
def capture(topic,publisher,until):
    s=None
    try:
        uri=xmlrpclib.ServerProxy(MASTER).lookupNode('/alfred_forward_test',publisher)[2]
        p=xmlrpclib.ServerProxy(uri).requestTopic('/alfred_forward_test',topic,[['TCPROS']])[2]
        s=socket.create_connection((p[1],p[2]),1)
        fields=['callerid=/alfred_forward_test','topic='+topic,'md5sum=*','tcp_nodelay=1']
        header=b''.join(struct.pack('<I',len(x))+x.encode() for x in fields)
        s.sendall(struct.pack('<I',len(header))+header);read(s);s.settimeout(.3)
        last=None;count=0
        while time.time()<until:
            try:payload=read(s)
            except socket.timeout:continue
            if topic=='/comm/SendData':
                if b'WA' not in payload:continue
            if topic.startswith('/protocol/') and payload[:2]!=b'WA':continue
            if topic=='/wheel/WheelDistanceReport':payload=payload[16:]
            value=binascii.hexlify(payload).decode()
            if value!=last and count<60:
                report({'topic':topic,'publisher':publisher,'hex':value,'time':time.time()});last=value;count+=1
    except Exception as e:report({'topic':topic,'error':str(e)})
    finally:
        if s:s.close()
def request(method,path,body):
    c=httplib.HTTPConnection('127.0.0.1',8765,timeout=.25)
    try:
        c.request(method,path,body,{'Content-Type':'application/json'})
        response=c.getresponse();data=response.read()
        if response.status!=200:raise RuntimeError(data)
        return data
    finally:c.close()
if __name__=='__main__':
    pubs=dict(xmlrpclib.ServerProxy(MASTER).getSystemState('/alfred_forward_test')[2][0])
    until=time.time()+4
    topics=['/wheel/SetWheelSpeed','/wheel/WheelDistanceReport','/motor/MotorProtection','/motor/MotorCurrent','/comm/SendData','/protocol/SendSAData','/protocol/RecvSAData']
    threads=[threading.Thread(target=capture,args=(t,p,until)) for t in topics for p in pubs.get(t,[])]
    for t in threads:t.start()
    time.sleep(.4)
    try:
        end=time.time()+2
        count=0
        while time.time()<end:
            request('PUT','/v1/drive','{"linear":0.2,"angular":0}');count+=1
            time.sleep(.08)
        report({'commands':count,'duration_seconds':2,'linear':.2})
    finally:report({'stop':request('POST','/v1/drive/stop','')})
    for t in threads:t.join()
