#!/usr/bin/env python
"""Read native SLAM telemetry and invoke the firmware work controller (Python 2)."""
from __future__ import print_function
import socket,struct,json,io,time,base64,threading,sys,ctypes,binascii,os,subprocess,signal,fcntl
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
 # Raw native values only; occupancy semantics have not been verified.
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
   # Diagnostic image only. Do not interpret this as an occupancy map.
   shades=bytearray(256)
   for v in range(256):shades[v]=v
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
   out['work']=work()
  except Exception as e:out['errors']['work']=str(e)
 threads=[threading.Thread(target=f) for f in [read_map,read_pose,read_work]]
 for t in threads:t.start()
 for t in threads:t.join()
 return out

# The firmware ships stale generated Python services. Pin the live schema used
# by the existing drive wake implementation, and probe before every command.
WORK_MD5='02b48ec9983e0e81cc0e264c502c304b'
LEASE='/data/alfred/state/map-lease.json'
LOCK='/data/alfred/state/map-lease.lock'
RESPONSES={0:'Accepted',1:'Firmware rejected the request',2:'Wheel lifted',3:'Dust bin missing',4:'Relocation in progress',5:'Robot preparing',6:'Remove mop pads before mapping',7:'Battery too low',8:'Robot is on the charger',9:'Power switch is off',10:'Firmware update in progress',11:'Cliff sensor error',12:'Bumper error',13:'Water unavailable',14:'Remote control is active',15:'Station not assigned',16:'No watch point'}
def work():
 meta,data=topic('/task/WorkState')
 if not meta.get('message_definition','').replace('\r','').startswith('uint8 worktype\nuint8 subtype\nuint8 state\n') or len(data)<3:raise RuntimeError('Unsupported work-state schema')
 return {'type':bytearray(data)[0],'subtype':bytearray(data)[1],'state':bytearray(data)[2]}
def control(action):
 name='/task/WorkManage'
 uri=master().lookupService(CALLER,name)[2];host,port=uri.split('://')[1].rstrip('/').rsplit(':',1)
 s=socket.create_connection((host,int(port)),2)
 try:
  header(s,['callerid='+CALLER,'service='+name,'md5sum=*','probe=1']);meta=metadata(frame(s))
 finally:s.close()
 if meta.get('md5sum')!=WORK_MD5:raise RuntimeError('Unsupported live WorkManage schema: '+str(meta.get('md5sum')))
 # manage, workType, string, CleanWorkData, ExtraWorkData; no cleaning outputs.
 payload=struct.pack('<BBI',{'start':0,'stop':1,'pause':2,'resume':3}[action],15,0)+b'\0'*45+struct.pack('<IIBHhhII',0,0,2,0,0,0,0,0)
 s=socket.create_connection((host,int(port)),2)
 try:
  header(s,['callerid='+CALLER,'service='+name,'md5sum='+WORK_MD5,'persistent=0'])
  metadata(frame(s));s.sendall(struct.pack('<I',len(payload))+payload)
  ok=exact(s,1);data=frame(s)
  if ok!=b'\x01' or len(data)!=1:raise RuntimeError('Invalid firmware control response')
  code=bytearray(data)[0]
  return {'code':code,'accepted':code==0,'message':RESPONSES.get(code,'Firmware rejection '+str(code))}
 finally:s.close()
def lease_read():
 try:
  with open(LEASE) as f:return json.load(f)
 except (IOError,ValueError):return {}
def lease_write(value):
 with open(LEASE+'.new','w') as f:json.dump(value,f)
 os.rename(LEASE+'.new',LEASE)
def lease_lock():
 if not os.path.isdir('/data/alfred/state'):os.makedirs('/data/alfred/state')
 f=open(LOCK,'a');fcntl.flock(f,fcntl.LOCK_EX);return f
def guardian():
 signal.signal(signal.SIGHUP,signal.SIG_IGN)
 # Only the current guardian PID owns the lease. A replacement retires this one.
 while True:
  time.sleep(1)
  with lease_lock():
   lease=lease_read()
   if lease.get('pid')!=os.getpid() or not lease.get('armed'):return
   if time.time()<=lease.get('expires',0):continue
   try:
    state=work()
    if state['type']==15 and state['state']==1:
     result=control('pause')
     if not result['accepted']:continue
    lease['armed']=False;lease['expired']=True;lease_write(lease);return
   except Exception:continue

def operate(action,owner):
 if not owner or len(owner)>80 or not all(c.isalnum() or c=='-' for c in owner):raise ValueError('Invalid scan owner')
 with lease_lock():
  lease=lease_read();state=work()
  if action=='heartbeat':
   if lease.get('owner')!=owner:raise RuntimeError('Mapping lease belongs to another scan')
   if lease.get('armed'):lease['expires']=time.time()+10;lease_write(lease)
   return {'work':state,'lease':lease,'observedAt':int(time.time()*1000)}
  if action=='start':
   if state['state']!=0:raise RuntimeError('Robot already has an active or paused task (type '+str(state['type'])+'). Stop it before starting a scan.')
  elif state['type']!=15:
   if action=='stop':return {'accepted':True,'code':0,'message':'Mapping already stopped','work':state}
   raise RuntimeError('Robot is not running a mapping task')
  if action in ('start','resume'):
   if action=='resume' and lease.get('owner')!=owner:raise RuntimeError('Cannot resume a different scan')
   # Start guardian before sending a command so ambiguous delivery is covered.
   process=subprocess.Popen([sys.executable,os.path.abspath(__file__),'guardian'],stdin=open(os.devnull),stdout=open(os.devnull,'w'),stderr=open(os.devnull,'w'),preexec_fn=os.setsid,close_fds=True)
   lease={'owner':owner,'pid':process.pid,'expires':time.time()+10,'armed':True,'expired':False};lease_write(lease)
  result=control(action)
  if action in ('stop','pause') and result['accepted']:
   lease['armed']=False;lease_write(lease)
  elif action in ('start','resume') and not result['accepted']:
   lease['armed']=False;lease_write(lease)
  result['work']=state;return result

def status():
 out={'work':work(),'lease':lease_read(),'observedAt':int(time.time()*1000)}
 try:
  _,data=topic('/prediction/PredictPose');from prediction.msg import PredictPose
  p=PredictPose().deserialize(data).pose
  out['pose']={'x':p.x/1000,'y':p.y/1000,'theta':p.theta,'frame':p.header.frame_id}
 except Exception as e:out['poseError']=str(e)
 return out
if __name__=='__main__':
 try:
  signal.signal(signal.SIGALRM,lambda signum,frame:(_ for _ in ()).throw(RuntimeError('Mapping operation timed out')))
  action=sys.argv[1] if len(sys.argv)>1 else 'status'
  if action=='guardian':guardian();sys.exit(0)
  signal.alarm(8)
  if action=='snapshot':result=snapshot()
  elif action=='status':result=status()
  elif action=='probe':
   # A STOP while idle validates control transport without starting motion.
   state=work()
   if state['state']!=0:raise RuntimeError('Probe requires an idle robot')
   result=control('stop');result['work']=state
  elif action in ('start','pause','resume','stop','heartbeat'):result=operate(action,sys.argv[2])
  else:raise ValueError('Unknown map action')
  print('ALFRED_MAP_JSON:'+json.dumps(result,separators=(',',':')))
 except Exception as e:
  print('ALFRED_MAP_JSON:'+json.dumps({'error':str(e)}));sys.exit(1)
