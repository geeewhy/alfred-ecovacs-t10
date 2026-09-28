import unittest
import numpy as np
from wall_verification import wall_goal
class WallGoals(unittest.TestCase):
 def test_standoff_is_reachable_and_faces_surface(self):
  grid=np.full((100,100),100);grid[10:80,10:80]=0
  walls=[{'id':'wall','points':[[1.,4.],[3.,4.]]}]
  goal=wall_goal(grid,.05,(0.,0.),{'x':2.,'y':2.,'theta':0.},walls,[])
  self.assertIsNotNone(goal)
  self.assertAlmostEqual(goal['y'],3.64)
  self.assertAlmostEqual(goal['theta'],np.arctan2(goal['surface'][1]-goal['y'],goal['surface'][0]-goal['x']))
 def test_failed_approach_tries_a_different_viewpoint(self):
  grid=np.full((100,100),100);grid[10:80,10:80]=0
  walls=[{'id':'wall','points':[[1.,4.],[3.,4.]]}]
  pose={'x':2.,'y':2.,'theta':0.}
  first=wall_goal(grid,.05,(0.,0.),pose,walls,[])
  first['result']='not_reached'
  second=wall_goal(grid,.05,(0.,0.),pose,walls,[first])
  self.assertIsNotNone(second)
  self.assertGreaterEqual(np.hypot(first['x']-second['x'],first['y']-second['y']),.22)
 def test_wall_in_another_component_is_not_a_goal(self):
  grid=np.full((150,150),100);grid[10:40,10:40]=0;grid[60:100,60:100]=0
  walls=[{'id':'outside','points':[[3.,5.],[5.,5.]]}]
  self.assertIsNone(wall_goal(grid,.05,(0.,0.),{'x':1.,'y':1.,'theta':0.},walls,[]))
if __name__=='__main__':unittest.main()
