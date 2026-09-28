import unittest,math
import numpy as np
from scipy.spatial import cKDTree
from localization_seed import refine_seed, advance_pose
class LocalizationSeed(unittest.TestCase):
 def test_refines_wrong_prior_without_becoming_pose_authority(self):
  points=[(x,0) for x in np.linspace(0,3,100)]+[(3,y) for y in np.linspace(0,1,50)]+[(x,1) for x in np.linspace(1,3,70)]
  actual=np.array([1.4,-.2]);tree=cKDTree(np.asarray(points)+actual)
  result=refine_seed(tree,points,{'x':0.,'y':0.,'theta':0.})
  self.assertLess(math.hypot(result['x']-actual[0],result['y']-actual[1]),.1)
  self.assertGreater(result['seed_score'],.8)
 def test_no_scan_keeps_prior(self):
  prior={'x':0.,'y':0.,'theta':0.}
  self.assertEqual(refine_seed(None,[],prior),prior)
class MovingLocalization(unittest.TestCase):
 def test_relative_motion_rotates_into_map_frame(self):
  pose={'x':4.,'y':2.,'theta':math.pi/2,'score':.95}
  result=advance_pose(pose,(10.,20.,0.),(11.,20.,math.pi/2))
  self.assertAlmostEqual(result['x'],4.)
  self.assertAlmostEqual(result['y'],3.)
  self.assertAlmostEqual(abs(result['theta']),math.pi)
  self.assertEqual(result['score'],.95)
  self.assertEqual(pose['y'],2.)
 def test_heading_wrap_and_inverse_motion(self):
  pose={'x':4.,'y':2.,'theta':-.7}
  before=(3.,5.,math.pi-.1);after=(3.2,5.1,-math.pi+.1)
  moved=advance_pose(pose,before,after)
  self.assertAlmostEqual(moved['theta'],-.5)
  restored=advance_pose(moved,after,before)
  for key in pose:self.assertAlmostEqual(restored[key],pose[key])
if __name__=='__main__':unittest.main()
