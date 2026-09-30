import unittest
from speech_endpoint import SpeechEndpoint
class EndpointTest(unittest.TestCase):
    def make(self):return SpeechEndpoint(lambda frame:frame==b'\x01\x00'*320)
    def test_two_seconds_not_one(self):
        e=self.make();e.accept(b'\x01\x00'*320*10)
        e.accept(bytes(640*99));self.assertFalse(e.ended)
        e.accept(bytes(640));self.assertTrue(e.ended)
    def test_resumed_speech_restarts_pause(self):
        e=self.make();e.accept(b'\x01\x00'*320*10);e.accept(bytes(640*90))
        e.accept(b'\x01\x00'*320*5);e.accept(bytes(640*99));self.assertFalse(e.ended)
        e.accept(bytes(640));self.assertTrue(e.ended)
    def test_silence_without_speech_never_submits(self):
        e=self.make();e.accept(bytes(640*500));self.assertFalse(e.ended)
    def test_odd_fragments_and_reset(self):
        e=self.make();pcm=b'\x01\x00'*320*10+bytes(640*100)
        for i in range(0,len(pcm),511):e.accept(pcm[i:i+511])
        self.assertTrue(e.ended);e.reset();self.assertFalse(e.ended)
if __name__=='__main__':unittest.main()
