#!/usr/bin/env python
from __future__ import print_function
import json,socket,sys
import map_bridge as ros
name=sys.argv[1];nodes=dict(ros.master().getSystemState(ros.CALLER)[2][0])[name]
uri=ros.master().lookupNode(ros.CALLER,nodes[0])[2]
protocol=ros.xmlrpclib.ServerProxy(uri).requestTopic(ros.CALLER,name,[['TCPROS']])[2]
s=socket.create_connection((protocol[1],protocol[2]),2)
try:
 ros.header(s,['callerid=/alfred_schema','topic='+name,'md5sum=*'])
 print(json.dumps(ros.metadata(ros.frame(s))))
finally:s.close()
