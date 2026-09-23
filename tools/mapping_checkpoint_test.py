#!/usr/bin/env python3
"""Run inside the mapping container against a saved graph; never drives the robot.
Usage: python3 mapping_checkpoint_test.py MAP_ID
"""
import json,math,pathlib,shutil,sys,tempfile,threading
from types import SimpleNamespace
sys.path.insert(0,'/alfred')
from slam_session import SlamSession
map_id=sys.argv[1]
source=pathlib.Path('/alfred/state/maps')/map_id
manifest=json.loads((source/'manifest.json').read_text())
with tempfile.TemporaryDirectory(prefix='alfred-checkpoint-') as temporary:
    directory=pathlib.Path(temporary)
    session=SlamSession.__new__(SlamSession)
    session.map_id=map_id;session.grid=manifest['grid'];session.location={'state':'located'}
    session.pose=lambda:manifest['pose'];session.last_pose=manifest['pose'];session.boot_id=manifest['boot_id']
    session.structure=None;session.sequence=1;session.serialize=None;session.save_lock=threading.RLock()
    session.directory=lambda _:directory;session.node=SimpleNamespace(update=lambda **_:None)
    def serialize(_,request):
        for extension in ('.posegraph','.data'):
            shutil.copyfile(source/(manifest['filename']+extension),request.filename+extension)
    session.service=serialize
    session.save()
    before=(directory/'manifest.json').read_bytes()
    data=session.structure
    assert data and data['keyframes'] and data['grid']['cells']
    assert all(math.isfinite(v) for f in data['keyframes'] for point in f['points'] for v in point)
    def incomplete(_,request):
        shutil.copyfile(source/(manifest['filename']+'.posegraph'),request.filename+'.posegraph')
    session.service=incomplete
    try:session.save()
    except RuntimeError:pass
    else:raise AssertionError('Incomplete graph was accepted')
    assert (directory/'manifest.json').read_bytes()==before
    session.location={'state':'failed'};session.save()
    assert (directory/'manifest.json').read_bytes()==before
    stopped=threading.Event();done=[]
    session.location_token=0;session.locating=False;session.capture=True
    session.node.control=lambda *_:stopped.set()
    session.status=lambda:{'capture':session.capture}
    with session.save_lock:
        worker=threading.Thread(target=lambda:done.append(session.control('pause',{})))
        worker.start()
        assert stopped.wait(.5), 'Stop waited for disk serialization'
        assert not session.capture
    worker.join(1);assert done and not worker.is_alive()
    print(json.dumps({'stop_preempts_serialization':True,'passed':True,'corrected_scans':len(data['keyframes']),'points':sum(len(f['points']) for f in data['keyframes']),'cells':len(data['grid']['cells']),'incomplete_snapshot_preserved_prior':True,'failed_localization_preserved_prior':True}))
