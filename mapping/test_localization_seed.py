import unittest,math
import numpy as np
from scipy.spatial import cKDTree
from localization_seed import refine_seed
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
if __name__=='__main__':unittest.main()
