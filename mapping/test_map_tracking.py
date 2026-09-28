"""Exercise admission/recovery sequencing without a ROS runtime or motors."""
import ast,math,time,unittest
from pathlib import Path
from collections import OrderedDict
from types import SimpleNamespace as NS
from unittest.mock import Mock
from localization_seed import advance_pose

class Tracking(unittest.TestCase):
 def session(self):
  tree=ast.parse(Path(__file__).with_name('slam_session.py').read_text())
  cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='SlamSession')
  names={'scan','pose_update','recover_tracking','map_evidence','save_locked'}
  cls.body=[n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name in names]
  env={'advance_pose':advance_pose,'math':math,'time':time,'threading':NS(Thread=Mock())}
  exec(compile(ast.Module(body=[cls],type_ignores=[]),'slam_session.py','exec'),env)
  obj=env['SlamSession']();obj.node=NS(odom=[99.,99.,0.],scan_pub=Mock(),engine_request=Mock(),control=Mock())
  obj.last_pose=None;obj.scan_odometry=OrderedDict();obj.reference_manifest={'filename':'good','grid':{'cells':[]}};obj.location={'state':'located'};obj.map_id='map';obj.capture=True;obj.locating=False;obj.location_token=4;obj.quality_hold=False;obj.map_evidence=Mock(return_value={'tracking_lost':False});obj.recovery_count=0
  return obj,env
 def scan(self):return NS(header=NS(stamp=NS(sec=7,nanosec=5)),angle_min=0.,angle_increment=.01,ranges=[1.]*120,range_min=.2,range_max=12.)
 def test_bad_scan_is_not_published_and_reference_is_preserved(self):
  o,e=self.session();o.map_evidence.return_value={'tracking_lost':True}
  o.scan(self.scan(),1,{'x':1,'y':2,'theta':0},(1.,2.,0.))
  o.node.scan_pub.publish.assert_not_called();self.assertFalse(o.capture);self.assertTrue(o.quality_hold);self.assertEqual(o.grid,o.reference_manifest['grid']);self.assertEqual(o.location['state'],'locating')
  e['threading'].Thread.assert_called_once()
 def test_good_scan_uses_acquisition_odometry(self):
  o,_=self.session();o.scan(self.scan(),1,{'x':1,'y':2,'theta':0},(1.,2.,.3))
  o.node.scan_pub.publish.assert_called_once();self.assertEqual(o.scan_snapshot[1],(1.,2.,.3))
  msg=NS(header=self.scan().header,pose=NS(pose=NS(position=NS(x=4.,y=5.),orientation=NS(w=1.,z=0.))))
  o.pose_update(msg);self.assertEqual(o.odom_at_pose,[1.,2.,.3])
 def test_pause_cancels_pending_recovery(self):
  o,_=self.session();o.recover_tracking(3);o.node.control.assert_not_called()
 def test_held_map_cannot_be_checkpointed(self):
  o,_=self.session();o.quality_hold=True;o.save_locked();o.node.engine_request.assert_not_called()
 def test_engine_restart_reinstalls_reference_once(self):
  o,_=self.session();del o.map_evidence
  o.node.engine_request.side_effect=[RuntimeError('Mapping reference not installed'),'installed',{'tracking_lost':False}]
  self.assertEqual(o.map_evidence('map',{},[]),{'tracking_lost':False});self.assertEqual(o.node.engine_request.call_count,3)

 def test_missing_tf_still_feeds_independently_verified_odometry_projection(self):
  o,_=self.session();o.last_pose={'x':4.,'y':2.,'theta':0.};o.odom_at_pose=(1.,2.,0.)
  o.scan(self.scan(),1,None,(1.3,2.,0.))
  o.node.scan_pub.publish.assert_called_once()
  self.assertAlmostEqual(o.map_evidence.call_args.args[1]['x'],4.3)
 def test_missing_tf_does_not_bypass_bad_scan_guard(self):
  o,_=self.session();o.last_pose={'x':4.,'y':2.,'theta':0.};o.odom_at_pose=(1.,2.,0.);o.map_evidence.return_value={'tracking_lost':True}
  o.scan(self.scan(),1,None,(1.3,2.,0.))
  o.node.scan_pub.publish.assert_not_called();self.assertTrue(o.quality_hold)
 def test_no_projection_recovers_instead_of_silently_starving_slam(self):
  o,e=self.session();o.scan(self.scan(),1,None,(1.,2.,0.))
  o.node.scan_pub.publish.assert_not_called();self.assertTrue(o.quality_hold)
  e['threading'].Thread.assert_called_once()
