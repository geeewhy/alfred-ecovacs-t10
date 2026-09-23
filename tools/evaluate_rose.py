"""Offline evaluation of upstream ROSE/ROSE2; its output never drives the robot."""
import json,sys,types,time,pathlib
import numpy as np
sys.path.insert(0,sys.argv[1]+'/src')
sys.modules['rospy']=types.SimpleNamespace(loginfo=print,logwarn=print,logerr=print)
from rose_v1_repo.fft_structure_extraction import FFTStructureExtraction
source=pathlib.Path(sys.argv[2]);value=json.loads(source.read_text());grid=value.get('snapshot',value)['map']
x0=min(c[0] for c in grid['cells'])-10;y0=min(c[1] for c in grid['cells'])-10
x1=max(c[0] for c in grid['cells'])+11;y1=max(c[1] for c in grid['cells'])+11
image=np.full((y1-y0,x1-x0),200,dtype=np.uint8)
for x,y,v in grid['cells']:image[y-y0,x-x0]=255 if v<=127 else 0
started=time.monotonic();rose=FFTStructureExtraction(image,peak_height=.2,par=50);rose.process_map()
report={'source':str(source),'directions':np.asarray(rose.main_directions).tolist(),'shape':image.shape}
try:
 if len(rose.main_directions)>2:
  rose.simple_filter_map(.18);rose.generate_initial_hypothesis_simple();rose.find_walls_flood_filing()
  from rose_v2_repo import minibatch,parameters
  params=parameters.ParameterObj();params.comp=list(rose.main_directions)
  output=minibatch.Minibatch();output.start_main(parameters,params,rose.analysed_map.astype(np.uint8),image,None,False)
  report.update(edges=len(output.edges_th1),rooms=len(output.rooms_th1 or []))
 else:report['result']='Upstream pipeline declined map: insufficient dominant directions'
except ValueError as error:
 report.update(result="Upstream pipeline declined partial map",error=str(error))
report['seconds']=time.monotonic()-started
path=pathlib.Path('artifacts/hq/rose-evaluation.json');path.write_text(json.dumps(report,indent=2));print(json.dumps(report))
