import pathlib,sys,subprocess,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'setup'))
import wifi
class NativeWifiTests(unittest.TestCase):
    def test_native_error_is_not_success(self):
        failed=subprocess.CompletedProcess([],7,'{"ok":false,"stage":"association","code":-3900}', '')
        with patch.object(wifi,'binary',return_value='/native/wifi'),patch.object(wifi.subprocess,'run',return_value=failed):
            with self.assertRaisesRegex(RuntimeError,'-3900'):wifi.call('join','ECOVACS_0150')
    def test_exact_ssid_and_native_backend(self):
        ok=subprocess.CompletedProcess([],0,'{"ok":true}', '')
        with patch.object(wifi,'binary',return_value='/native/wifi'),patch.object(wifi.subprocess,'run',return_value=ok) as run:
            self.assertTrue(wifi.call('join','ECOVACS_0150')['ok'])
            self.assertEqual(run.call_args.args[0],['/native/wifi','join','ECOVACS_0150'])
if __name__=='__main__':unittest.main()
