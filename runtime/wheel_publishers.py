#!/usr/bin/env python
"""Read-only attribution of wheel commands from every ROS publisher."""
from __future__ import print_function
import json,socket,time,threading,binascii
import map_bridge as ros
TOPIC='/wheel/SetWheelSpeed'
result=[]
def inspect(node):
 out={'node':node,'samples':[]}
 try:
  uri=ros.master().lookupNode(ros.CALLER,node)[2]
  protocol=ros.xmlrpclib.ServerProxy(uri).requestTopic(ros.CALLER,TOPIC,[['TCPROS']])[2]
  s=socket.create_connection((protocol[1],protocol[2]),1);s.settimeout(.4)
  try:
   ros.header(s,['callerid=/alfred_wheel_audit','topic='+TOPIC,'md5sum=*'])
   meta=ros.metadata(ros.frame(s));out['schema']=meta.get('message_definition');end=time.time()+1.5
   while time.time()<end:
    try:
     value=binascii.hexlify(ros.frame(s)).decode()
     if not out['samples'] or out['samples'][-1]!=value:out['samples'].append(value)
    except socket.timeout:pass
  finally:s.close()
 except Exception as e:out['error']=str(e)
 result.append(out)
nodes=dict(ros.master().getSystemState(ros.CALLER)[2][0])[TOPIC]
threads=[threading.Thread(target=inspect,args=(n,)) for n in nodes]
for t in threads:t.start()
for t in threads:t.join()
print(json.dumps(result))
