#!/usr/bin/env python3
"""Rebuild a paused map's old dense checklist using the current Deep pass policy."""
import json, pathlib, sys, urllib.request, shutil, time, os
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'mapping'))
from deep_pass import DeepPass
active=json.load(urllib.request.urlopen('http://127.0.0.1:4173/api/maps/active',timeout=3))['result']
if active and active.get('state')=='scanning':raise RuntimeError('Pause mapping first')
map_id=sys.argv[1]
import uuid
uuid.UUID(map_id)
p=ROOT/'artifacts/hq/maps'/f'{map_id}.json'
m=json.loads(p.read_text());old=m['scan'].get('deepPass')
if not old:raise RuntimeError('Map has no Deep pass checklist')
walls=[{'id':f'edge-{i}','points':e['points'],'unknown':e['kind']=='unobserved'} for i,e in enumerate(m.get('structure',{}).get('floor',{}).get('boundary',[]))]
if not walls:raise RuntimeError('Map has no floor contour')
d=DeepPass(old);d.refresh(walls)
backup=ROOT/'artifacts/hq/map-backups'/f'{map_id}-{int(time.time())}-dense-checks.json'
backup.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,backup)
m['scan']['deepPass']=d.status()
tmp=p.with_suffix('.json.tmp');tmp.write_text(json.dumps(m));os.replace(tmp,p)
print(json.dumps({'before':old['total'],'after':d.status()['total'],'verified':d.status()['verified']}))
