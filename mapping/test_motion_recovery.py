import unittest
from motion_recovery import MotionRecovery, blocked
P={'x':0.,'y':0.,'theta':0.}
class RecoveryTest(unittest.TestCase):
    def stall(self,r):
        self.assertIsNone(r.step(0.,P,.12,0.,[],.12))
        for i in range(1,20):r.step(i*.1,P,.12,0.,[],.12)
        self.assertEqual(r.step(2.1,P,.12,0.,[],.12),(-.06,0.))
        self.assertEqual(r.event,'pause')
    def test_stall_backs_up_then_bounded_faster_retry(self):
        r=MotionRecovery();self.stall(r)
        r.step(3.5,{**P,'x':-.11},0.,0.,[],.12)
        v=r.step(4.2,{**P,'x':-.10},0.,0.,[],.12)
        self.assertGreater(v[0],.12);self.assertLessEqual(v[0],.2)
        self.assertEqual(r.step(5.,{**P,'x':.23},0.,0.,[],.12),(0.,0.));self.assertEqual(r.event,'resume')
    def test_reverse_cannot_run_forever(self):
        r=MotionRecovery();self.stall(r)
        with self.assertRaisesRegex(RuntimeError,'back away'):r.step(5.,P,0.,0.,[],.12)
    def test_wall_prevents_momentum_retry(self):
        wall=[{'x':300+i,'y':i,'power':1} for i in range(5)]
        r=MotionRecovery()
        for i in range(22):r.step(i*.1,P,.12,0.,wall,.12)
        r.step(3.,{**P,'x':-.11},0.,0.,wall,.12)
        self.assertEqual(r.phase,'turn');self.assertEqual(r.event,'blocked')
    def test_real_progress_does_not_trigger(self):
        r=MotionRecovery()
        for i in range(30):self.assertIsNone(r.step(i*.2,{**P,'x':i*.012},.06,0.,[],.12))
    def test_reverse_surface_stops_and_noise_does_not(self):
        points=[{'x':-220-i,'y':i,'power':1} for i in range(3)]
        self.assertFalse(blocked(points[:1],False,.32));self.assertTrue(blocked(points,False,.32))
        r=MotionRecovery()
        for i in range(20):r.step(i*.1,P,.12,0.,[],.12)
        with self.assertRaisesRegex(RuntimeError,'behind'):r.step(2.1,P,.12,0.,points,.12)
    def test_creeping_commands_detect_slip_but_not_slow_travel(self):
        stuck=MotionRecovery();moving=MotionRecovery()
        for i in range(42):
            stuck.step(i*.1,P,.013,0.,[],.12)
            self.assertIsNone(moving.step(i*.1,{**P,'x':i*.0013},.013,0.,[],.12))
        self.assertEqual(stuck.phase,'back')
if __name__=='__main__':unittest.main()
