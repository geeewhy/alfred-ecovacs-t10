#!/usr/bin/env python
"""Read native SLAM telemetry and invoke the firmware work controller (Python 2)."""
from __future__ import print_function
import socket,struct,json,io,time,base64,threading,sys,ctypes,binascii
try:import xmlrpclib
except ImportError:import xmlrpc.client as xmlrpclib
socket.setdefaulttimeout(2)
CALLER='/alfred_maps'
class zlib:
 crc32=staticmethod(binascii.crc32)
 @staticmethod
 def compress(data,level=6):
  lib=ctypes.CDLL('libz.so.1');lib.compressBound.argtypes=[ctypes.c_ulong];lib.compressBound.restype=ctypes.c_ulong
  size=ctypes.c_ulong(lib.compressBound(len(data)));out=ctypes.create_string_buffer(size.value)
  lib.compress2.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong),ctypes.c_char_p,ctypes.c_ulong,ctypes.c_int]
  if lib.compress2(out,ctypes.byref(size),data,len(data),level)!=0:raise RuntimeError('Map compression failed')
  return out.raw[:size.value]
def master():return xmlrpclib.ServerProxy('http://127.0.0.1:11311')
def exact(s,n):
 b=b''
 while len(b)<n:
  p=s.recv(n-len(b))
  if not p:raise IOError('ROS connection closed')
  b+=p
 return b
def frame(s):
 n=struct.unpack('<I',exact(s,4))[0]
 if n>8*1024*1024:raise ValueError('ROS frame too large')
 return exact(s,n)
def header(s,fields):
 data=b''.join(struct.pack('<I',len(v))+v.encode() for v in fields);s.sendall(struct.pack('<I',len(data))+data)
def metadata(data):
 out={}
 while data:
  n=struct.unpack('<I',data[:4])[0];key,value=data[4:4+n].decode('utf-8','replace').split('=',1);out[key]=value;data=data[4+n:]
 if 'error' in out:raise RuntimeError(out['error'])
 return out
def topic(name):
 pubs=dict(master().getSystemState(CALLER)[2][0]);nodes=pubs.get(name,[])
 if not nodes:raise RuntimeError('No publisher for '+name)
 uri=master().lookupNode(CALLER,nodes[0])[2]
 proto=xmlrpclib.ServerProxy(uri).requestTopic(CALLER,name,[['TCPROS']])[2]
 s=socket.create_connection((proto[1],proto[2]),2)
 try:
  header(s,['callerid='+CALLER,'topic='+name,'md5sum=*','tcp_nodelay=1']);meta=metadata(frame(s));return meta,frame(s)
 finally:s.close()
def service(name,kind,request):
 uri=master().lookupService(CALLER,name)[2];host,port=uri.split('://')[1].split(':');s=socket.create_connection((host,int(port)),2)
 try:
  header(s,['callerid='+CALLER,'service='+name,'md5sum='+kind._md5sum]);metadata(frame(s))
  buffer=io.BytesIO();request.serialize(buffer);data=buffer.getvalue();s.sendall(struct.pack('<I',len(data))+data)
  ok=exact(s,1);data=frame(s)
  if ok!=b'\x01':raise RuntimeError(data)
  return kind._response_class().deserialize(data)
 finally:s.close()
def png(width,height,data):
 def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 # SLAM grid: 0 unknown, positive free, negative occupied; confirmed from firmware map format.
 # Preserve raw categories with a palette; rows are flipped to put +Y up on screen.
 palette=b''.join(bytes(bytearray([v,v,v])) for v in range(256))
 rows=b''.join(b'\x00'+data[y*width:(y+1)*width] for y in range(height-1,-1,-1))
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,3,0,0,0))+chunk(b'PLTE',palette)+chunk(b'IDAT',zlib.compress(rows,6))+chunk(b'IEND',b'')
def snapshot():
 out={'observedAt':int(time.time()*1000),'errors':{}}
 def read_map():
  try:
   meta,data=topic('/slam/SlamMap')
   width,height,xmin,xmax,ymin,ymax,resolution=struct.unpack_from('<HHfffff',data)
   n=struct.unpack_from('<I',data,24)[0];cells=data[28:]
   if n!=width*height or len(cells)!=n or n>4000000:raise ValueError('Invalid SLAM grid')
   # Expose a histogram to verify native occupancy values instead of guessing.
   histogram={}
   for value in bytearray(cells):histogram[value]=histogram.get(value,0)+1
   # Typical Ecovacs signed grid is -1 unknown, 0 free, 100 occupied.
   shades=bytearray(256)
   for v in range(256):shades[v]=225 if v==255 else (248 if v==0 else 55 if 1<=v<=100 else 180)
   pixels=bytes(bytearray(shades[v] for v in bytearray(cells)))
   out['grid']={'width':width,'height':height,'bounds':[xmin/1000,ymin/1000,xmax/1000,ymax/1000],'resolution':resolution/1000,'png':base64.b64encode(png(width,height,pixels)).decode(),'histogram':histogram}
  except Exception as e:out['errors']['grid']=str(e)
 def read_pose():
  try:
   meta,data=topic('/prediction/PredictPose');from prediction.msg import PredictPose
   p=PredictPose().deserialize(data).pose
   out['pose']={'x':p.x/1000,'y':p.y/1000,'theta':p.theta,'frame':p.header.frame_id}
  except Exception as e:out['errors']['pose']=str(e)
 def read_work():
  try:
   meta,data=topic('/task/WorkState');out['work']={'type':bytearray(data)[0],'state':bytearray(data)[1]}
  except Exception as e:out['errors']['work']=str(e)
 threads=[threading.Thread(target=f) for f in [read_map,read_pose,read_work]]
 for t in threads:t.start()
 for t in threads:t.join()
 return out
if __name__=='__main__':
 try:
  action=sys.argv[1] if len(sys.argv)>1 else 'snapshot'
  if action=='snapshot':result=snapshot()
  elif action in ('start','pause','resume','stop'):
   from task.srv import WorkManage,WorkManageRequest
   request=WorkManageRequest();request.managetype={'start':0,'stop':1,'pause':2,'resume':3}[action];request.workType=15
   response=service('/task/WorkManage',WorkManage,request);result={'response':response.response}
  else:raise ValueError('Unknown map action')
  print('ALFRED_MAP_JSON:'+json.dumps(result,separators=(',',':')))
 except Exception as e:
  print('ALFRED_MAP_JSON:'+json.dumps({'error':str(e)}));sys.exit(1)
