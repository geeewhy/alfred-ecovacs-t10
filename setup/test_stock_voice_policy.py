import unittest
from unittest.mock import patch, mock_open
import firmware_policy as policy
class VoicePolicyTest(unittest.TestCase):
    def test_only_stock_assistants_are_stopped(self):
        commands={'1':b'audioDaemon\0','2':b'/usr/bin/bds_audio_service\0','3':b'speech_inter_client\0','4':b'speech_mute_notify\0'}
        def opened(name,*args):
            return mock_open(read_data=commands.get(name.split('/')[2],b''))()
        with patch.object(policy.os.path,'exists',return_value=True), patch.object(policy.os,'listdir',return_value=list(commands)), patch('builtins.open',side_effect=opened), patch.object(policy.os,'kill') as kill:
            self.assertEqual(policy.suppress_stock_voice(),[3,4])
            self.assertEqual([call.args[0] for call in kill.call_args_list],[3,4])
    def test_opt_in(self):
        with patch.object(policy.os.path,'exists',return_value=False),patch.object(policy.os,'kill') as kill:
            self.assertEqual(policy.suppress_stock_voice(),[])
            kill.assert_not_called()
