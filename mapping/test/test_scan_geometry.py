import math,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scan_geometry import ScanGeometry
class DeskewTests(unittest.TestCase):
 def test_rotating_sweep_recovers_a_straight_stationary_wall(self):
  geometry=ScanGeometry()
  for i in range(41):geometry.odometry(i*.005,(0,0,i*.005*.5))
  points=[];expected=[]
  for i in range(100):
   t=(i+1)*.002;angle=.5*t;y=-1+i*.02
   points.append({'x':1000*(2*math.cos(angle)+y*math.sin(angle)),'y':1000*(-2*math.sin(angle)+y*math.cos(angle)),'power':1})
   expected.append((2*math.cos(.1)+y*math.sin(.1),-2*math.sin(.1)+y*math.cos(.1)))
  result=geometry.points({'source_stamp':.2,'points':points})
  self.assertLess(max(math.dist(a,b) for a,b in zip(result,expected)),1e-6)
 def test_missing_history_does_not_invent_a_pose(self):
  geometry=ScanGeometry();geometry.odometry(1.,(0,0,0))
  self.assertIsNone(geometry.points({'source_stamp':1.,'points':[{'x':1000,'y':0,'power':1}]}))
if __name__=='__main__':unittest.main()
