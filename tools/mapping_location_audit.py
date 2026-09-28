#!/usr/bin/env python3
"""Read-only global scan-fit audit; candidate poses never command the robot."""
import json,urllib.request,sys,time,math
import numpy as np
from scipy.spatial import cKDTree
from scipy.optimize import minimize
from pathlib import Path
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'mapping/state/maps'/sys.argv[1]/'manifest.json').read_text());g=manifest['grid'];res=g['resolution'];origin=np.array(g['origin'])
scan=json.load(urllib.request.urlopen('http://127.0.0.1:48765/v1/telemetry/lidar',timeout=3))['result']
if scan['age_ms']>750:raise RuntimeError('Fresh scan required')
# Match the bridge's stationary angular binning and coherent-return filter.
ranges=np.full(720,np.inf)
for p in scan['points']:
 if p['power']<=0:continue
 x,y=p['x']/1000,p['y']/1000;r=math.hypot(x,y)
 if not .19<r<12:continue
 i=round((math.atan2(y,x)+math.pi)/(2*math.pi/720))%720
 ranges[i]=min(ranges[i],r)
xy=[]
for i,r in enumerate(ranges):
 if not math.isfinite(r):continue
 support=sum(math.isfinite(ranges[(i+d)%720]) and abs(ranges[(i+d)%720]-r)<.06 for d in range(-2,3))
 if support>=3:
  angle=-math.pi+i*2*math.pi/720;xy.append([r*math.cos(angle),r*math.sin(angle)])
xy=np.asarray(xy);xy=xy[::max(1,len(xy)//180)]
if len(xy)<50:raise RuntimeError('Insufficient coherent scan returns')

ref=cKDTree(np.array([[x+.5,y+.5] for x,y,v in g['cells'] if v>127])*res+origin)
free=np.array([[x+.5,y+.5] for x,y,v in g['cells'] if v<=127])*res+origin
_,ix=np.unique(np.floor(free/.3).astype(int),axis=0,return_index=True);free=free[ix]
started=time.monotonic();candidates=[]
for theta in np.arange(-math.pi,math.pi,math.pi/18):
 c,s=math.cos(theta),math.sin(theta);r=xy@np.array([[c,s],[-s,c]])
 ds=ref.query((free[:,None,:]+r[None,:,:]).reshape(-1,2))[0].reshape(len(free),len(xy))
 costs=np.minimum(ds,.3).mean(axis=1)
 for i in np.argsort(costs)[:4]:candidates.append((float(costs[i]),[free[i,0],free[i,1],theta]))
candidates.sort(key=lambda x:x[0]);out=[]
def distances(p):
 c,s=math.cos(p[2]),math.sin(p[2]);return ref.query(xy@np.array([[c,s],[-s,c]])+p[:2])[0]
occupied={(x,y) for x,y,v in g['cells'] if v>127}
def ray_conflicts(p):
 c,s=math.cos(p[2]),math.sin(p[2]);ends=xy@np.array([[c,s],[-s,c]])
 conflicts=0
 for end in ends:
  length=np.linalg.norm(end)
  if length<.45:continue
  ray=np.arange(.2,length-.15,res)[:,None]*end/length+np.asarray(p[:2])
  cells=np.floor((ray-origin)/res).astype(int)
  # Two successive occupied samples exclude isolated occupancy speckles.
  hits=[tuple(cell) in occupied for cell in cells]
  conflicts+=any(a and b for a,b in zip(hits,hits[1:]))
 return conflicts/len(ends)
candidates.sort(key=lambda item:item[0]+.2*ray_conflicts(item[1]))
for _,p in candidates:
 if any(math.dist(p[:2],q['pose'][:2])<.5 and abs(math.atan2(math.sin(p[2]-q['pose'][2]),math.cos(p[2]-q['pose'][2])))<.4 for q in out):continue
 fit=minimize(lambda p:np.minimum(distances(p),.3).mean()+.2*ray_conflicts(p),p,method='Powell',bounds=[(p[0]-.35,p[0]+.35),(p[1]-.35,p[1]+.35),(p[2]-.2,p[2]+.2)],options={'maxiter':30})
 out.append({'pose':fit.x.tolist(),'cost':float(fit.fun),'ray_conflicts':ray_conflicts(fit.x),'agreement':float(np.mean(distances(fit.x)<.1))})
 if len(out)>=6:break
result={'seconds':time.monotonic()-started,'prior':manifest['pose'],'prior_ray_conflicts':ray_conflicts([manifest['pose'][k] for k in ('x','y','theta')]),'candidates':sorted(out,key=lambda q:q['cost'])}
if len(sys.argv)>2:
 destination=Path(sys.argv[2]);destination.parent.mkdir(parents=True,exist_ok=True)
 destination.write_text(json.dumps({'map_id':sys.argv[1],'scan':scan,'grid':g,'result':result}))
print(json.dumps(result))
