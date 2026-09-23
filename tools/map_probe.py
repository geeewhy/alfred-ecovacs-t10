#!/usr/bin/env python
from __future__ import print_function
import socket,struct,xmlrpclib,json,io
socket.setdefaulttimeout(3)
MASTER=xmlrpclib.ServerProxy('http://127.0.0.1:11311')
def exact(s,n):
 b=b''
 while len(b)<n:
  p=s.recv(n-len(b))
  if not p:raise IOError('connection closed')
  b+=p
 return b
def read(s):return exact(s,struct.unpack('<I',exact(s,4))[0])
def header(s,fields):
 b=b''.join(struct.pack('<I',len(v))+v.encode() for v in fields);s.sendall(struct.pack('<I',len(b))+b)
def service(name,kind,request):
 uri=MASTER.lookupService('/alfred_maps',name)[2];host,port=uri.split('://')[1].split(':');s=socket.create_connection((host,int(port)),3)
 try:
  header(s,['callerid=/alfred_maps','service='+name,'md5sum='+kind._md5sum]);read(s)
  b=io.BytesIO();request.serialize(b);data=b.getvalue();s.sendall(struct.pack('<I',len(data))+data)
  ok=exact(s,1);data=read(s)
  if ok!=b'\x01':raise IOError(data)
  return kind._response_class().deserialize(data)
 finally:s.close()
if __name__=='__main__':
 from map.srv import ManipulateMapInfos,ManipulateMapInfosRequest,GetCurrentCompressMap,GetCurrentCompressMapRequest
 from task.srv import GetMapBuildState,GetMapBuildStateRequest
 for n,t,r in [('/map/ManipulateMapInfos',ManipulateMapInfos,ManipulateMapInfosRequest()),('/task/GetMapBuildState',GetMapBuildState,GetMapBuildStateRequest())]:
  try:print(n,str(service(n,t,r)))
  except Exception as e:print(n,str(e))
 from map.srv import GetCurrentCompressMap,GetCurrentCompressMapRequest
 try:
  v=service('/map/GetCurrentCompressMap',GetCurrentCompressMap,GetCurrentCompressMapRequest(0,0));print('map',v.result,str(v.CompressMap.info),'tiles',len(v.CompressMap.submaps))
 except Exception as e:print(str(e))
