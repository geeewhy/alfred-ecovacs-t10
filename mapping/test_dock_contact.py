"""Contact freshness is local elapsed time, independent of every wall clock."""
import ast,math,unittest,http.client
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from docking import Docking

class ContactTests(unittest.TestCase):
    def test_stale_contact_holds_and_fresh_contact_resumes_without_clock_sync(self):
        clock=SimpleNamespace(monotonic=lambda:10.)
        tree=ast.parse(Path(__file__).with_name('bridge.py').read_text())
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Bridge')
        method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='docking_velocity')
        env={'time':clock,'math':math}
        exec(compile(ast.Module(body=[method],type_ignores=[]),'bridge.py','exec'),env)
        dock=Docking({'x':0,'y':0,'theta':0},[],'boot',0,{'x':0,'y':0,'theta':0})
        dock.step=Mock(return_value=(-.02,0.))
        bridge=SimpleNamespace(dock_waking_since=None,docking=dock,lease=30,dock_contact=({'docked':False,'percent':70,'observedAt':9999999999999},8.),update=Mock(),stop_docking=Mock(),command=(0.,0.,10.),odom=(0.,0.,0.),odom_epoch=0)
        step=env['docking_velocity']
        self.assertEqual(step(bridge,{},None),(0.,0.));dock.step.assert_not_called();self.assertIsNone(dock.error)
        for timestamp in [-9999999999999,9999999999999]:
            bridge.dock_contact=({'docked':False,'percent':70,'observedAt':timestamp},9.9)
            self.assertEqual(step(bridge,{},None),(-.02,0.))
            self.assertIsNone(dock.recovery_since)
        bridge.stop_docking.assert_not_called()

class AcquisitionTests(unittest.TestCase):
    def test_return_holds_on_acquisition_and_transport_but_terminates_hard_faults(self):
        tree=ast.parse(Path(__file__).with_name('bridge.py').read_text())
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Bridge')
        method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='docking_fault')
        clock=SimpleNamespace(monotonic=lambda:10.)
        send=Mock();env={'time':clock,'http':http,'request':send}
        exec(compile(ast.Module(body=[method],type_ignores=[]),'bridge.py','exec'),env)
        for error in (RuntimeError('Waiting for scan odometry history'),RuntimeError('Wheel odometry stale'),TimeoutError('read timed out')):
            dock=Docking({'x':0,'y':0,'theta':0},[],'boot',0,{'x':0,'y':0,'theta':0})
            dock.pulse={'active':True}
            bridge=SimpleNamespace(docking=dock,lease=30,dock_waking_since=None,command=(.02,0.,10.),update=Mock(),stop_docking=Mock())
            clock.monotonic=lambda:10.
            env['docking_fault'](bridge,error)
            self.assertIsNone(dock.error);self.assertIsNone(dock.pulse)
            self.assertEqual(bridge.command,(0.,0.,0.));bridge.stop_docking.assert_not_called()
            send.assert_called_with('/v1/drive/stop',method='POST')
            clock.monotonic=lambda:15.
            env['docking_fault'](bridge,error)
            self.assertIn('5 seconds',dock.error);bridge.stop_docking.assert_called_once()
        for reason in ('Wheel counter discontinuity','cliff/lift detected','Unknown controller error'):
            bridge.stop_docking.reset_mock();dock.error=None
            env['docking_fault'](bridge,RuntimeError(reason))
            bridge.stop_docking.assert_called_once_with(reason)

if __name__=='__main__':unittest.main()
