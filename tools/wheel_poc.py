#!/usr/bin/env python
"""Device-side POC: both wheels forward at 24 mm/s for two seconds."""
from __future__ import print_function
import socket,struct,threading,time,xmlrpclib
from SimpleXMLRPCServer import SimpleXMLRPCServer
from motor_snapshot import read,MASTER
from forward_test import capture,report,request
TOPIC='/wheel/SetWheelSpeed';NODE='/alfred_wheel_poc'
CLIENTS=[];LOCK=threading.Lock();READY=threading.Event();CLOSED=threading.Event()
def send(speed):
    body=struct.pack('<BIff',1,2,speed,speed)
    packet=struct.pack('<I',len(body))+body
    with LOCK:
        for s in list(CLIENTS):
            try:s.sendall(packet)
            except socket.error:CLIENTS.remove(s);s.close()
def accept(listener):
    while not CLOSED.is_set():
        try:s,_=listener.accept()
        except socket.timeout:continue
        try:
            h=read(s)
            fields=['callerid='+NODE,'md5sum=6136b114420b8e6600151ac57541e32e','type=wheel/SetWheelSpeed','latching=0']
            h_out=b''.join(struct.pack('<I',len(x))+x.encode() for x in fields)
            s.sendall(struct.pack('<I',len(h_out))+h_out)
            with LOCK:CLIENTS.append(s)
            if b'callerid=/node' in h:READY.set()
        except Exception:s.close()
def main():
    master=xmlrpclib.ServerProxy(MASTER)
    # Stop any previous engine command before the direct POC.
    request('POST','/v1/drive/stop','')
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(8);listener.settimeout(.2)
    rpc=SimpleXMLRPCServer(('127.0.0.1',0),logRequests=False,allow_none=True)
    rpc.register_function(lambda caller,topic,protocols:[1,'ready',['TCPROS','127.0.0.1',listener.getsockname()[1]]],'requestTopic')
    rpc.register_function(lambda caller:[1,'alive',1],'getPid')
    for target in (lambda:accept(listener),rpc.serve_forever):
        t=threading.Thread(target=target);t.daemon=True;t.start()
    uri='http://127.0.0.1:%d/'%rpc.server_address[1]
    master.registerPublisher(NODE,TOPIC,'wheel/SetWheelSpeed',uri)
    try:
        if not READY.wait(3):raise RuntimeError('Hardware node did not connect; no motion sent')
        pubs=dict(master.getSystemState(NODE)[2][0]);until=time.time()+3.5
        topics=['/wheel/WheelDistanceReport','/motor/MotorCurrent','/motor/MotorProtection','/protocol/SendSAData','/comm/SendData']
        threads=[threading.Thread(target=capture,args=(t,p,until)) for t in topics for p in pubs.get(t,[])]
        for t in threads:t.start()
        time.sleep(.3)
        # Separate stop timer is armed before sending a nonzero speed.
        timer=threading.Timer(2,lambda:send(0));timer.start()
        try:
            deadline=time.time()+2
            while time.time()<deadline:
                send(24.0);time.sleep(.08)
        finally:
            send(0);timer.join();send(0)
        report({'poc':'forward','mm_s':24,'seconds':2,'stop_sent':True})
        for t in threads:t.join()
    finally:
        send(0);CLOSED.set()
        master.unregisterPublisher(NODE,TOPIC,uri)
        rpc.shutdown();listener.close()
if __name__=='__main__':main()
