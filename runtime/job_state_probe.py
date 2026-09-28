#!/usr/bin/env python
"""Read only: inspect the pinned firmware scheduler's startup gate."""
from __future__ import print_function
import os,struct,json,hashlib,time
library='/usr/lib/node/liberos_node_job_schedule.so'
if hashlib.sha256(open(library,'rb').read()).hexdigest()!='41c8816113c3045e38934cd614b6cf4a304f7717086c31ae637c8ed60a1bf475':raise RuntimeError('Unsupported scheduler firmware')
for pid in os.listdir('/proc'):
 if not pid.isdigit():continue
 try:
  if b'/etc/conf/dxai_node.json' not in open('/proc/'+pid+'/cmdline','rb').read():continue
  lines=[line.split() for line in open('/proc/'+pid+'/maps')]
  mapped=[v for v in lines if len(v)>5 and v[-1]==library]
  if not mapped:continue
  base=min(int(v[0].split('-')[0],16)-int(v[2],16) for v in mapped)
  needle=struct.pack('<Q',base+0xa17e0)
  mem=open('/proc/'+pid+'/mem','rb',0);started=time.time();found=[]
  for v in lines:
   if len(v)<6 or v[-1]!='[heap]':continue
   low,high=[int(x,16) for x in v[0].split('-')]
   for pos in range(low,min(high,low+128*1024*1024),1024*1024):
    if time.time()-started>3:break
    mem.seek(pos);data=mem.read(min(1024*1024+8,high-pos));offset=data.find(needle)
    while offset>=0:
     addr=pos+offset;mem.seek(addr+0x324);ready=struct.unpack('<I',mem.read(4))[0]
     found.append({'startup_complete':ready})
     offset=data.find(needle,offset+8)
  mem.seek(base+0xa2e58);state=struct.unpack('<Q',mem.read(8))[0]
  values={}
  if state:
   for label,offset in [('dirtbox_state',0),('charging_state',0x10),('in_station',0x1c),('work_type',0x24),('work_state',0x28)]:
    mem.seek(state+offset);values[label]=struct.unpack('<I',mem.read(4))[0]
  mem.close();print(json.dumps({'pid':int(pid),'scheduler':found,'logic_state':values}))
 except (IOError,OSError):continue
