#!/usr/bin/env python3
"""Bounded stationary AMCL comparison; restores baseline parameters on exit."""
import json,subprocess,sys,time,urllib.request
from pathlib import Path
MAP=sys.argv[1]
def api(base,path,body=None):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
 value=json.load(urllib.request.urlopen(req,timeout=13))
 if not value['ok']:raise RuntimeError(value.get('error'))
 return value['result']
def parameters(model):
 weights=[.5,.05,.05,.5] if model=='likelihood_field' else [.8,.05,.05,.1]
 values={'laser_model_type':model,**dict(zip(['z_hit','z_short','z_max','z_rand'],weights))}
 code="""import rclpy,json
from rcl_interfaces.srv import SetParametersAtomically
from rclpy.parameter import Parameter
rclpy.init();n=rclpy.create_node('alfred_model_probe');c=n.create_client(SetParametersAtomically,'/alfred_localizer/set_parameters_atomically')
if not c.wait_for_service(timeout_sec=3):raise RuntimeError('Localizer unavailable')
req=SetParametersAtomically.Request();req.parameters=[Parameter(k,value=v).to_parameter_msg() for k,v in VALUES.items()]
f=c.call_async(req);rclpy.spin_until_future_complete(n,f,timeout_sec=5)
if not f.done() or not f.result().result.successful:raise RuntimeError('Parameter change rejected')
print('Parameters applied');n.destroy_node();rclpy.shutdown()
""".replace('VALUES',repr(values))
 subprocess.run(['docker','exec','-e','ROS_DOMAIN_ID=42','alfred-mapping','bash','-c','source /opt/ros/jazzy/setup.bash && python3 -c "$1"','probe',code],timeout=10,check=True,capture_output=True)
hq='http://127.0.0.1:4173';companion='http://127.0.0.1:48766';results=[]
active=api(hq,'/api/maps/active')
if active and active['state'] in ('scanning','locating'):raise RuntimeError('Pause current operation before probing')
try:
 for model in ('likelihood_field','beam'):
  parameters(model)
  api(hq,'/api/maps/'+MAP+'/scan',{'action':'locate','mode':'manual'})
  frames=[];started=time.monotonic()
  while time.monotonic()-started<14:
   state=api(companion,'/status')['mapping']['location'];frames.append(state)
   if state['state'] in ('failed','located'):break
   time.sleep(.5)
  results.append({'model':model,'seconds':time.monotonic()-started,'frames':frames})
  print(json.dumps({'model':model,'result':frames[-1]}),flush=True)
  api(hq,'/api/maps/'+MAP+'/scan',{'action':'pause'})
finally:
 try:api(hq,'/api/maps/'+MAP+'/scan',{'action':'pause'})
 finally:parameters('likelihood_field')
 out=Path(__file__).resolve().parents[1]/'artifacts/hq/localization/model-comparison.json'
 out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(results,indent=2))
