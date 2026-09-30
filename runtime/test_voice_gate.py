import unittest
from voice_gate import addressed_command

GOOD=[dict(no_speech_prob=.05,avg_logprob=-.2,compression_ratio=1)]
class AddressingTest(unittest.TestCase):
    def test_background_and_self_speech(self):
        for text in ['Thank you.','The The The The The The','I am here, sir.','Very good, sir.']:
            self.assertIsNone(addressed_command(text,GOOD))
    def test_direct_address(self):
        self.assertEqual(addressed_command('Hey Alfred, go to Bedroom.',GOOD),'go to Bedroom.')
        self.assertEqual(addressed_command('Alfred?',GOOD),'Alfred')
        self.assertIsNone(addressed_command('I was talking about Alfred.',GOOD))
        self.assertIsNone(addressed_command('Alfredo go home.',GOOD))
    def test_awake_request_and_summons(self):
        self.assertEqual(addressed_command('What is your battery?',GOOD,awakened=True),'What is your battery?')
        self.assertEqual(addressed_command('Alfred.',GOOD,awakened=True),'')
    def test_bad_segment_cannot_hide_behind_good_one(self):
        self.assertIsNone(addressed_command('Alfred go home',GOOD+[dict(no_speech_prob=.99)]))
        self.assertIsNone(addressed_command('Alfred go home',[]))
if __name__=='__main__':unittest.main()
