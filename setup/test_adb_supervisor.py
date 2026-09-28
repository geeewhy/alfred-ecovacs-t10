import unittest
from adb_supervisor import tick
class SupervisorTests(unittest.TestCase):
    def test_existing_daemon_is_never_restarted(self):
        starts=[];self.assertFalse(tick([123],False,lambda:starts.append(1)));self.assertEqual(starts,[])
    def test_dead_daemon_is_restarted(self):
        starts=[];self.assertTrue(tick([],False,lambda:starts.append(1)));self.assertEqual(starts,[1])
    def test_explicit_stop_prevents_restart(self):
        starts=[];self.assertFalse(tick([],True,lambda:starts.append(1)));self.assertEqual(starts,[])
if __name__=='__main__':unittest.main()
