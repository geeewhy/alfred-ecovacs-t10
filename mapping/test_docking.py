import unittest,math,copy
import numpy as np
from docking import Docking,fit_enclosure,rotation,wrap,relative

TEMPLATE=[[-.16,float(y)] for y in np.linspace(-.18,.18,45)]+[[float(x),y] for y in (-.18,.18) for x in np.linspace(-.16,.06,35)]
STATION={'x':0.,'y':0.,'theta':0.}
def scan_at(out=.15,lateral=0.,heading=0.):
    xy=(np.asarray(TEMPLATE)-[out,lateral])@rotation(-heading).T
    return [{'x':float(x*1000),'y':float(y*1000),'power':1} for x,y in xy]
def frame(points):
    return {'native':{'boot_id':'boot','reports':{'/task/WorkState':{'bytes':[7,255,0]}},'wheels':{'values':[0.,0.],'stamp':1.,'age_ms':0}},'lidar':{'points':points,'sequence':1,'age_ms':0},'bumpers':{'fresh':True,'left':False,'right':False,'cliff_raw':0,'wheel_lift_raw':0}}
BATTERY={'percent':90,'low_voltage':False,'on_charger':False}
class DockTests(unittest.TestCase):
    def controller(self,out=.15,lateral=0.,heading=0.):
        pose={'x':out,'y':lateral,'theta':heading};d=Docking(STATION,TEMPLATE,'boot',0,pose)
        return d,frame(scan_at(out,lateral,heading)),pose
    def test_fit_recovers_translation_and_rotation_with_outliers(self):
        p=[-.31,.07,.28];xy=np.asarray(TEMPLATE)@rotation(p[2]).T+p[:2]
        points=[{'x':x*1000,'y':y*1000,'power':1} for x,y in xy]+[{'x':800+i*3,'y':300,'power':1} for i in range(60)]
        f=fit_enclosure(TEMPLATE,points,[-.24,.03,.2]);self.assertIsNotNone(f)
        self.assertLess(np.linalg.norm(np.array(f['target'][:2])-p[:2]),.012);self.assertLess(abs(f['target'][2]-p[2]),.04)
    def test_recorded_outside_scan_does_not_fit_hidden_template_points(self):
        import json
        from pathlib import Path
        root=Path(__file__).parent
        sample=json.loads((root/'fixtures/dock-approach.json').read_text())
        template=json.loads((root/'calibration/dock-enclosure.json').read_text())['points']
        fit=fit_enclosure(template,sample['points'],sample['prior'])
        self.assertIsNotNone(fit)
        self.assertLess(abs(wrap(fit['target'][2]-sample['prior'][2])),.05)
        self.assertLess(np.linalg.norm(np.array(fit['target'][:2])-sample['prior'][:2]),.04)
    def test_map_guided_approach_does_not_require_enclosure_recognition(self):
        from unittest.mock import patch
        for out,lateral,heading in ((.8,.1,math.pi),(.45,0.,1.),(.4,.02,.1)):
            d,f,p=self.controller(out,lateral,heading)
            with patch('docking.fit_enclosure',side_effect=AssertionError('early recognition')):
                v,w=d.step(.5,f,p,BATTERY)
            self.assertGreater(abs(v)+abs(w),0)
            self.assertEqual(d.acquisition['source'],'map')
            self.assertIsNone(d.error)
    def test_failed_final_shape_match_does_not_veto_known_station(self):
        from unittest.mock import patch
        d,f,p=self.controller(.20,.02,.1)
        with patch('docking.fit_enclosure',return_value=None):
            v,w=d.step(.5,f,p,BATTERY)
        self.assertLess(v,0);self.assertIsNone(d.error)
    def test_reverse_approach_checks_clearance(self):
        d,f,p=self.controller(.5)
        f['lidar']['points'] += [{'x':-190-i,'y':0,'power':1} for i in range(5)]
        self.assertEqual(d.step(.5,f,p,BATTERY),(0.,0.))
        self.assertIn('obstructed',d.error)

    def test_oblique_recorded_dock_accepts_viewpoint_contour_variation(self):
        import json
        from pathlib import Path
        root=Path(__file__).parent
        sample=json.loads((root/'fixtures/dock-oblique-rejection.json').read_text())
        template=json.loads((root/'calibration/dock-enclosure.json').read_text())['points']
        fit=fit_enclosure(template,sample['points'],sample['prior'])
        self.assertIsNotNone(fit)
        self.assertGreater(min(fit['surfaces']),.9)
        self.assertLess(np.linalg.norm(np.array(fit['target'][:2])-sample['prior'][:2]),.05)
    def test_missing_surface_and_wrong_width_are_not_docks(self):
        for template in (TEMPLATE[:45]+TEMPLATE[80:],TEMPLATE[45:],[[x,y*2] for x,y in TEMPLATE]):
            points=[{'x':(x-.6)*1000,'y':y*1000,'power':1} for x,y in template]
            self.assertIsNone(fit_enclosure(TEMPLATE,points,[-.6,0.,0.]))

    def test_single_wall_is_not_a_dock(self):
        points=[{'x':-.3*1000,'y':y*1000,'power':1} for y in np.linspace(-.5,.5,200)]
        self.assertIsNone(fit_enclosure(TEMPLATE,points,[-.15,0,0]))
    def test_ramp_entry_preserves_drive_across_segments_and_stops_on_charge(self):
        d,f,p=self.controller(.10);v,w=d.step(.5,f,p,BATTERY);self.assertEqual(v,-.10);self.assertLessEqual(abs(w),.04)
        f['native']['wheels']['values']=[-61.,-61.]
        self.assertLess(d.step(.6,f,p,BATTERY)[0],0)
        self.assertEqual(d.step(.7,f,p,{**BATTERY,'on_charger':True}),(0.,0.))
    def test_ramp_entry_safety_interrupts_active_segment(self):
        d,f,p=self.controller(.10)
        self.assertEqual(d.step(.5,f,p,BATTERY)[0],-.10)
        f['bumpers']['cliff_raw']=1
        self.assertEqual(d.step(.55,f,p,BATTERY),(0.,0.))
        self.assertIsNotNone(d.error)
    def test_ramp_entry_without_measured_progress_terminates(self):
        d,f,p=self.controller(.10)
        for i in range(40):
            f['lidar']['sequence']=i+1
            d.step(.5+i*.4,f,p,BATTERY)
            if d.error:break
        self.assertIsNotNone(d.error)
        self.assertIn('progress',d.error)

    def test_fast_approach_requires_margin_and_slows_before_half_metre(self):
        for out,expected in ((.8,-.15),(.59,-.10),(.5,-.10)):
            d,f,p=self.controller(out)
            v,w=d.step(.5,f,p,BATTERY)
            self.assertEqual(v,expected)
            if out>.6:
                self.assertLessEqual(d.pulse['max_distance'],out-.55)
                f['native']['wheels']['values']=[-51.,-51.]
                self.assertEqual(d.step(.6,f,p,BATTERY),(0.,0.))

    def test_crooked_inside_exits_without_turning(self):
        d,f,p=self.controller(.15,.06,.10);v,w=d.step(.5,f,p,BATTERY);self.assertGreater(v,0);self.assertEqual(w,0)
    def test_contact_stops_before_confirmation(self):
        d,f,p=self.controller();d.step(.5,f,p,BATTERY)
        b={**BATTERY,'on_charger':True};self.assertEqual(d.step(.6,f,p,b),(0.,0.));self.assertFalse(d.done)
        d.step(1.7,f,p,b);self.assertTrue(d.done)
    def test_charging_stops_even_when_dock_puts_lidar_to_sleep(self):
        d,f,p=self.controller();f['lidar']['age_ms']=2000
        self.assertEqual(d.step(.5,f,p,{**BATTERY,'on_charger':True}),(0.,0.))
        d.step(1.6,f,p,{**BATTERY,'on_charger':True});self.assertTrue(d.done)
    def test_conflicting_task_reboot_and_sensor_failures_stop(self):
        for change in [lambda f:f['native'].update(boot_id='new'),lambda f:f['native']['reports']['/task/WorkState'].update(bytes=[5,255,1]),lambda f:f['bumpers'].update(left=True),lambda f:f['lidar'].update(age_ms=900)]:
            d,f,p=self.controller();change(f);self.assertEqual(d.step(.5,f,p,BATTERY),(0.,0.));self.assertIsNotNone(d.error)
    def test_cancel_cannot_resume_a_pulse(self):
        d,f,p=self.controller();d.step(.5,f,p,BATTERY);d.cancel();self.assertEqual(d.step(.6,f,p,BATTERY),(0.,0.))
    def test_no_contact_cannot_reverse_indefinitely(self):
        d,f,p=self.controller(-.02);d.retries=2;self.assertEqual(d.step(.5,f,p,BATTERY),(0.,0.));self.assertIn('Charging contact',d.error)
    def test_contact_retry_counts_attempts_not_observations(self):
        d,f,p=self.controller(-.025)
        for i in range(3):
            f['lidar']['sequence']+=1
            d.step(.5+i*2,f,p,BATTERY)
            d.step(1.3+i*2,f,p,BATTERY)
        self.assertIsNone(d.error);self.assertEqual(d.retries,1);self.assertTrue(d.reseat)
    def test_local_enclosure_tracking_survives_map_pose_loss(self):
        d,f,p=self.controller();f.update(odom=(0.,0.,0.),odom_epoch=0)
        d.step(.5,f,p,BATTERY)
        f['native']['wheels']['values']=[-7.,-7.];f['odom']=(-.007,0.,0.)
        d.step(.6,f,None,BATTERY);f['lidar'].update(sequence=2,points=scan_at(.143))
        d.step(1.1,f,None,BATTERY);self.assertIsNone(d.error);self.assertIsNotNone(d.local_pose)
        f['odom_epoch']=1;self.assertEqual(d.step(1.2,f,None,BATTERY),(0.,0.));self.assertIn('odometry',d.error)
    def test_blocked_exit_never_moves(self):
        d,f,p=self.controller();f["lidar"]["points"] += [{"x":190+i,"y":0,"power":1} for i in range(5)]
        self.assertEqual(d.move(.5,f["native"]["wheels"],f["lidar"],.025,0.),(0.,0.));self.assertIsNotNone(d.error)
    def test_staging_tolerance_cannot_leave_a_lateral_dead_zone(self):
        d,f,p=self.controller(.428,-.024,0.)
        v,w=d.step(.5,f,p,BATTERY)
        self.assertLess(v,0)
        self.assertGreater(abs(w),0)
        self.assertEqual(d.message,'Backing into station and correcting alignment')
    def test_rear_alignment_dead_zone_enters_instead_of_zero_turning(self):
        for lateral in (-.03,.03):
            d,f,p=self.controller(.45,lateral,.01);d.aligning=True
            v,w=d.step(.5,f,p,BATTERY)
            self.assertEqual(v,-.10)
            self.assertGreater(w*lateral,0)
    def test_outside_turn_is_decisive_and_inside_entry_steers(self):
        d,f,p=self.controller(.45,0.,1.0);d.aligning=True
        v,w=d.step(.5,f,p,BATTERY)
        self.assertEqual(v,0.);self.assertGreaterEqual(abs(w),.5)
        self.assertEqual(d.pulse['max_angle'],.30)
        d,f,p=self.controller(.20,.025,.12)
        v,w=d.step(.5,f,p,BATTERY)
        self.assertEqual(v,-.10);self.assertNotEqual(w,0.)
        self.assertFalse(d.correcting)

    def test_complete_return_from_crooked_outside_pose(self):
        d,f,p=self.controller(.38,-.10,1.3);v=w=0.
        for i in range(3602):
            t=i*.05;p['x']+=v*.05*math.cos(p['theta']);p['y']+=v*.05*math.sin(p['theta']);p['theta']+=w*.05
            f['native']['wheels']['values'][0]+=(v-w*.243/2)*50
            f['native']['wheels']['values'][1]+=(v+w*.243/2)*50
            f['lidar'].update(points=scan_at(p['x'],p['y'],p['theta']),sequence=i//4)
            contact=p['x']<=0 and abs(p['y'])<.018 and abs(p['theta'])<.08
            v,w=d.step(t,f,p,{**BATTERY,'on_charger':contact})
            if d.done or d.error:break
        self.assertTrue(d.done,(p,d.status()))
        self.assertLess(t,90.,'Return simulation must not spend minutes aligning')
    def test_return_facing_station_with_noisy_fits_and_contact_read_outage(self):
        from unittest.mock import patch
        rng=np.random.default_rng(7)
        d,f,p=self.controller(.8,-.04,math.pi-.15);v=w=0.
        def noisy_fit(template,points,prior):
            target=rotation(-p['theta'])@np.array([-p['x'],-p['y']])
            target+=rng.normal(0,.008,2)
            return {'target':[*target,wrap(-p['theta']+rng.normal(0,.025))],'score':.9,'rms':.015,'surfaces':[.9]*3}
        with patch('docking.fit_enclosure',side_effect=noisy_fit):
            for i in range(6001):
                t=i*.05;p['x']+=v*.05*math.cos(p['theta']);p['y']+=v*.05*math.sin(p['theta']);p['theta']=wrap(p['theta']+w*.05)
                f['native']['wheels']['values'][0]+=(v-w*.243/2)*50
                f['native']['wheels']['values'][1]+=(v+w*.243/2)*50
                f.update(odom=(p['x'],p['y'],p['theta']),odom_epoch=0)
                f['lidar'].update(points=scan_at(p['x'],p['y'],p['theta']),sequence=i//4)
                if 12<t<14:v,w=d.recover_telemetry(t,'contact');continue
                d.recovery_since=None
                contact=p['x']<=0 and abs(p['y'])<.018 and abs(p['theta'])<.08
                v,w=d.step(t,f,p,{**BATTERY,'on_charger':contact})
                if d.done or d.error:break
        self.assertTrue(d.done,(p,d.status()))
        self.assertLess(t,90.,'Return simulation must not spend minutes aligning')
    def test_unknown_enclosure_never_moves(self):
        d,f,p=self.controller();f['lidar']['points']=[]
        for t in [.5,1.,6.]:f['lidar']['sequence']+=1;self.assertEqual(d.step(t,f,p,BATTERY),(0.,0.))
        self.assertIsNotNone(d.error)
class RecoveryTests(unittest.TestCase):
    def test_transient_contact_loss_preserves_intent_but_stops_pulse(self):
        d=Docking(STATION,TEMPLATE,'boot',0,{'x':.2,'y':0,'theta':0})
        d.pulse={'velocity':(-.02,0)}
        self.assertEqual(d.recover_telemetry(1,'contact'),(0.,0.))
        self.assertIsNone(d.pulse);self.assertIsNone(d.error)
        self.assertEqual(d.phase,'observe')
        d.recover_telemetry(5.9,'contact');self.assertIsNone(d.error)
        d.recover_telemetry(6,'contact');self.assertIsNotNone(d.error)

if __name__=='__main__':unittest.main()
