#!/usr/bin/env python
"""Read-only docking telemetry snapshot on the robot, with live ROS schemas."""
from __future__ import print_function
import map_bridge as ros
import threading,json,time,importlib
TOPICS=['/power/ChargeState','/power/ChargeSignals','/power/ChargeStateConfirm','/map/ChargerDockInfo','/power/ChargerType','/omni/connectState','/return/frontDock']
def encode(v):
 if hasattr(v,'__slots__'):return {k:encode(getattr(v,k)) for k in v.__slots__}
 if isinstance(v,(tuple,list)):return [encode(x) for x in v]
 return v
out={'observed_at_unix':time.time(),'topics':{}}
def read(name):
 try:
  meta,data=ros.topic(name);pkg,kind=meta['type'].split('/')
  cls=getattr(importlib.import_module(pkg+'.msg'),kind)
  out['topics'][name]={'definition':meta.get('message_definition'),'value':encode(cls().deserialize(data))}
 except Exception as e:out['topics'][name]={'error':str(e)}
threads=[threading.Thread(target=read,args=(t,)) for t in TOPICS]
for t in threads:t.start()
for t in threads:t.join(4)
print(json.dumps(out))
