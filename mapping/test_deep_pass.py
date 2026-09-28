import unittest
import numpy as np
from deep_pass import DeepPass
class DeepPassTests(unittest.TestCase):
 def test_whole_map_target_beyond_old_four_meter_limit(self):
  d=DeepPass();d.refresh([{'id':'far','points':[[8.,1.],[8.,3.]]}])
  grid=np.zeros((220,220),dtype=int)
  goal=d.goal(grid,.05,(0.,0.),{'x':1.,'y':2.,'theta':0.})
  self.assertIsNotNone(goal)
  self.assertGreater(goal['x'],7.)
  self.assertEqual(d.status()['total'],2)
 def test_dense_saved_queue_is_rebuilt_without_losing_checks(self):
  walls=[{'id':'wall','points':[[1.,1.],[7.,1.]]}]
  old={'targets':[{'id':f'section-{i+1}','point':[1.+i*.35,1.],'points':walls[0]['points'],'unknown':False,'state':'verified' if i==0 else 'pending','attempts':[]} for i in range(17)]}
  d=DeepPass(old);d.refresh(walls)
  self.assertEqual(d.status()['verified'],1)
  self.assertLessEqual(d.status()['total'],5)
  self.assertEqual(d.status()['version'],2)
 def test_pending_target_moves_with_corrected_contour(self):
  d=DeepPass();d.refresh([{'id':'wall','points':[[1.,1.],[3.,1.]]}])
  ids=[t['id'] for t in d.targets]
  d.refresh([{'id':'wall','points':[[1.,1.2],[3.,1.2]]}])
  self.assertEqual([t['id'] for t in d.targets],ids)
  self.assertTrue(all(abs(t['point'][1]-1.2)<1e-8 for t in d.targets))
 def test_resume_keeps_verified_and_retries_unfinished(self):
  d=DeepPass();d.refresh([{'id':'edge','points':[[1.,1.],[3.,1.]],'unknown':True}])
  pose={'x':2.,'y':2.,'theta':0.};grid=np.zeros((100,100),dtype=int)
  goal=d.goal(grid,.05,(0.,0.),pose);d.started(goal);d.record(goal,'observed')
  goal=d.goal(grid,.05,(0.,0.),pose);d.started(goal);d.record(goal,'not_reached')
  saved=d.status();resumed=DeepPass(saved);resumed.refresh([{'id':'edge','points':[[1.,1.],[3.,1.]],'unknown':True}])
  self.assertEqual(resumed.status()['verified'],1)
  self.assertEqual(resumed.status()['total'],2)
  self.assertEqual(resumed.status()['remaining'],1)
  self.assertTrue(all(not t['attempts'] for t in resumed.targets if t['state']!='verified'))
if __name__=='__main__':unittest.main()
