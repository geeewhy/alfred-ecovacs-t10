import hashlib,importlib.util,os,pathlib,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('policy',pathlib.Path(__file__).with_name('firmware_policy.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();root=self.tmp.name
        self.file=pathlib.Path(root)/'library';self.data=bytearray(0x2dad4+8);
        for offset,before,after in p.PATCHES:self.data[offset:offset+4]=before
        self.file.write_bytes(self.data)
        self.proc={'pid':123,'inode':self.file.stat().st_ino,'instructions':['ff4308d1','e0010054'],'disabled':False}
        self.patches=[patch.object(p,'ROOT',root),patch.object(p,'FLAG',root+'/enabled'),patch.object(p,'TARGET',str(self.file)),patch.object(p,'ORIGINAL',hashlib.sha256(self.data).hexdigest()),patch.object(p,'loaded',side_effect=lambda:[self.proc.copy()]),patch.object(p.subprocess,'check_call',side_effect=self.change)]
        for v in self.patches:v.start()
    def tearDown(self):
        for v in reversed(self.patches):v.stop()
        self.tmp.cleanup()
    def change(self,args):
        disabled=args[-1]=='enable';self.proc.update(disabled=disabled,instructions=['c0035fd6','1f2003d5'] if disabled else ['ff4308d1','e0010054'])
    def test_roundtrip_and_idempotence(self):
        self.assertTrue(p.apply('enable')['disabled_live']);p.apply('enable');self.assertEqual(p.subprocess.check_call.call_count,1)
        self.assertFalse(p.apply('disable')['disabled_live']);self.assertFalse(os.path.exists(p.FLAG));self.assertEqual(self.file.read_bytes(),self.data)
    def test_rejects_wrong_library_and_stale_mapping(self):
        self.proc['inode']+=1
        with self.assertRaises(RuntimeError):p.apply('enable')
        self.proc['inode']-=1;self.file.write_bytes(b'wrong')
        with self.assertRaises(RuntimeError):p.apply('enable')
        p.subprocess.check_call.assert_not_called()
    def test_unknown_live_instruction(self):
        self.proc['instructions'][0]='00000000'
        with self.assertRaises(RuntimeError):p.apply('enable')
        self.assertFalse(os.path.exists(p.FLAG));p.subprocess.check_call.assert_not_called()
    def test_boot_only_reapplies_when_enabled(self):
        p.apply('boot');p.subprocess.check_call.assert_not_called()
        p.apply('enable');self.change(['disable']);p.apply('boot');self.assertTrue(self.proc['disabled'])
    def test_failed_helper_does_not_enable(self):
        p.subprocess.check_call.side_effect=RuntimeError('failed')
        with self.assertRaises(RuntimeError):p.apply('enable')
        self.assertFalse(os.path.exists(p.FLAG))
    def test_only_callback_entry_changes(self):
        modified=p.build(bytes(self.data));expected=bytearray(self.data)
        for offset,before,after in p.PATCHES:expected[offset:offset+4]=after
        self.assertEqual(modified,expected)

if __name__=='__main__':unittest.main()
