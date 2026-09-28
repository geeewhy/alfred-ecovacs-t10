import unittest,math,json
from pathlib import Path
from global_seed import global_seed, independent_obstructions
import numpy as np
class GlobalSeed(unittest.TestCase):
 def test_recorded_known_position_merges_converged_search_hypotheses(self):
  fixture=json.loads((Path(__file__).parent/'fixtures/known-position-duplicate-seeds.json').read_text())
  result=global_seed(fixture['grid'],fixture['points'],budget=30)
  self.assertIsNotNone(result)
  self.assertLess(math.hypot(result['x']-4.54,result['y']-1.17),.12)
  self.assertGreater(result['seed_score'],.9)
  self.assertGreater(result['seed_margin'],.025)
 def test_repeated_rooms_do_not_produce_a_unique_seed(self):
  cells=[]
  for offset in (0,60):
   for x in range(41):
    for y in range(41):cells.append([x+offset,y,129 if x in (0,40) or y in (0,40) else 127])
  points=[]
  for i in range(40):
   v=-1+i*.05
   points.extend([(v,-1),(v,1),(-1,v),(1,v)])
  grid={'cells':cells,'width':101,'height':41,'origin':[0,0],'resolution':.05}
  self.assertIsNone(global_seed(grid,points,budget=5))
 def test_thick_endpoint_band_is_not_an_intervening_wall(self):
  fractions=np.arange(.2,3.,.05);valid=np.ones((1,len(fractions)),bool)
  hits=np.array([fractions>=2.55])
  self.assertEqual(independent_obstructions(hits,valid,fractions,np.array([3.]),.05),0.)
  hits[0,(fractions>=1.)&(fractions<=1.2)]=True
  self.assertEqual(independent_obstructions(hits,valid,fractions,np.array([3.]),.05),1.)
 def test_separate_thin_wall_still_conflicts(self):
  fractions=np.arange(.2,3.,.05);hits=np.array([(fractions>=1.)&(fractions<1.12)])
  self.assertEqual(independent_obstructions(hits,np.ones_like(hits),fractions,np.array([3.]),.05),1.)
 def test_insufficient_scan_cannot_seed(self):
  self.assertIsNone(global_seed({},[(1,1)]*20))
if __name__=='__main__':unittest.main()
