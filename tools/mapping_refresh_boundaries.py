#!/usr/bin/env python3
"""Attach live disconnected frontier locations to a paused saved map."""
import json,pathlib,sys,subprocess,urllib.request,os
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'mapping'))
from refinement import frontier_regions
map_id=sys.argv[1]
def get(port,path):return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=3))['result']
nav=get(48766,'/status')
if nav['active'] or nav['mapping']['map_id']!=map_id:raise RuntimeError('Use the paused, currently loaded map')
record=subprocess.run(['docker','exec','-i','alfred-mapping','bash','-c','source /opt/ros/jazzy/setup.bash; python3 -'],input=(ROOT/'tools/mapping_costmap_snapshot.py').read_bytes(),capture_output=True,timeout=8,check=True)
snapshot=json.loads(record.stdout)['global_costmap/costmap']
grid=np.asarray(snapshot['cells']).reshape(snapshot['height'],snapshot['width']);grid=np.where(grid<0,-1,np.where(grid>=99,100,0))
frontiers=frontier_regions(grid,snapshot['resolution'],snapshot['origin'],nav['mapping']['pose'],nav['mapping'].get('graph',[]))
latest=get(48766,'/status');active=get(4173,'/api/maps/active')
if latest['active'] or latest['mapping']['map_id']!=map_id or active and active.get('state')=='scanning':raise RuntimeError('Capture started; refusing to overwrite live scan')
filename=ROOT/'artifacts/hq/maps'/f'{map_id}.json';m=json.loads(filename.read_text())
m['scan']['boundaryMarkers']=frontiers['markers'];m['scan']['unresolvedFrontiers']=frontiers['disconnected']
if 'unmapped boundaries remain' in m['scan'].get('message',''):
 m['scan']['message']=f"{frontiers['disconnected']} unmapped boundaries need another approach. Map saved for Resume."
temporary=filename.with_suffix('.json.tmp');temporary.write_text(json.dumps(m));os.replace(temporary,filename)
print(json.dumps(frontiers))
