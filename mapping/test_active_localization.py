import math,unittest
from active_localization import observation_step,station_from_departure,combined_views

class Engine:
    def __init__(self):self.t=0.;self.distance=0.;self.speed=0.;self.commands=[];self.obstacle=False;self.work=0
    def sleep(self,seconds):self.distance+=self.speed*seconds;self.t+=seconds
    def request(self,path,body=None,method=None):
        if path.endswith('/battery'):return {'percent':80,'low_voltage':False}
        if path.endswith('/frame'):
            return {'native':{'boot_id':'boot','reports':{'/task/WorkState':{'bytes':[7,255,self.work]}},'wheels':{'values':[self.distance]*2,'stamp':self.t,'age_ms':0}},'lidar':{'age_ms':0,'points':[{'x':250+i,'y':0,'power':1} for i in range(3)] if self.obstacle else []}}
        self.commands.append((path,body));self.speed=body['linear_mm_s'] if path.endswith('/twist') else 0

class ActiveLocalization(unittest.TestCase):
    def test_views_preserve_a_world_landmark_after_translation_and_turn(self):
        views=[([(2.,0.)],(0.,0.,0.)), ([(1.,0.)],(1.,0.,0.))]
        points=combined_views(views,(1.,0.,math.pi/2))
        for x,y in points:self.assertAlmostEqual(x,0.);self.assertAlmostEqual(y,-1.)
    def test_station_backprojection_includes_heading_and_translation(self):
        result=station_from_departure({'x':4.,'y':2.3,'theta':math.pi/2},(.3,0.,0.),(0.,0.,0.))
        self.assertAlmostEqual(result['x'],4.);self.assertAlmostEqual(result['y'],2.)
        turned=station_from_departure({'x':4.,'y':2.3,'theta':math.pi},(.3,0.,math.pi/2),(0.,0.,0.))
        self.assertAlmostEqual(turned['y'],2.);self.assertAlmostEqual(turned['theta'],math.pi/2)
    def test_observation_move_is_measured_bounded_and_stops(self):
        e=Engine();distance=observation_step(e.request,lambda:True,'boot',lambda:e.t,e.sleep)
        self.assertGreaterEqual(distance,.18);self.assertLess(distance,.20);self.assertEqual(e.speed,0)
        self.assertTrue(e.commands[-1][0].endswith('/stop'))
    def test_obstacle_and_other_controller_prevent_motion(self):
        for kind in ['obstacle','work']:
            e=Engine();setattr(e,kind,True)
            with self.assertRaises(RuntimeError):observation_step(e.request,lambda:True,'boot',lambda:e.t,e.sleep)
            self.assertEqual(e.distance,0);self.assertTrue(all(not path.endswith('/twist') for path,_ in e.commands))
    def test_cancel_stops_during_motion(self):
        e=Engine()
        with self.assertRaisesRegex(RuntimeError,'cancelled'):observation_step(e.request,lambda:e.t<.3,'boot',lambda:e.t,e.sleep)
        self.assertEqual(e.speed,0);self.assertLess(e.distance,40)
    def test_reboot_prevents_motion(self):
        e=Engine()
        with self.assertRaisesRegex(RuntimeError,'restarted'):observation_step(e.request,lambda:True,'old',lambda:e.t,e.sleep)
        self.assertEqual(e.distance,0)

if __name__=='__main__':unittest.main()
