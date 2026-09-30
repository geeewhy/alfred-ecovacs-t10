import unittest,itertools
from pcm_frames import PcmFrames
class FramingTest(unittest.TestCase):
    def test_arbitrary_http_boundaries_preserve_every_sample(self):
        data=bytes(range(256))*128
        frame=PcmFrames();actual=[];i=0
        for size in itertools.cycle([511,1537,4095,1]):
            if i>=len(data):break
            actual.extend(frame.accept(data[i:i+size]));i+=size
        self.assertEqual(b''.join(actual),data)
        self.assertEqual(frame.pending,b'')
    def test_partial_sample_survives_next_read(self):
        frame=PcmFrames(4)
        self.assertEqual(frame.accept(b'abc'),[])
        self.assertEqual(frame.accept(b'def'),[b'abcd'])
        self.assertEqual(frame.accept(b'gh'),[b'efgh'])
if __name__=='__main__':unittest.main()
