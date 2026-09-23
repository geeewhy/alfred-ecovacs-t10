#!/usr/bin/env python3
"""Exercise native SLAM lifecycle, recording grid and pose evidence; no wheel commands."""
import json, pathlib, time, urllib.request
BASE='http://127.0.0.1:48765'
def api(path,action=False):
    request=urllib.request.Request(BASE+path,method='POST' if action else 'GET')
    with urllib.request.urlopen(request,timeout=3) as response:
        result=json.load(response)
    if not result['ok']:raise RuntimeError(result['result'])
    return result['result']
def snapshot():
    grid=api('/v1/mapping/native/grid')
    return {'at':time.time(),'grid':grid,'status':api('/v1/mapping/native/status')}
def main():
    records=[]
    try:
        for action in ['start','pause','resume']:
            api('/v1/mapping/native/'+action,True)
            for _ in range(3):
                time.sleep(1)
                records.append({'action':action,**snapshot()})
                last=records[-1]
                print(action,'sequence',last['grid']['sequence'],'cells',len(last['grid']['cells']),
                      'pose',last['status']['pose'],flush=True)
    finally:
        api('/v1/drive/stop',True)
        api('/v1/mapping/native/pause',True)
        folder=pathlib.Path(__file__).resolve().parents[1]/'artifacts/hq/mapping-runs'
        folder.mkdir(parents=True,exist_ok=True)
        path=folder/f'{int(time.time()*1000)}-native-gate.json'
        path.write_text(json.dumps(records));print(path)
if __name__=='__main__':main()
