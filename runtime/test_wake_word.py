"""Acoustic regression suite; requires installed local voice dependencies/models."""
import pathlib,sys,unittest,wave,subprocess,tempfile,shutil,itertools
from pcm_frames import PcmFrames
from wake_word import WakeWord,ROOT,MODEL

@unittest.skipUnless((ROOT/'artifacts/voice-models'/MODEL).exists(),'Install the wake model first')
class WakeAudioTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.wake=WakeWord()
    def hits(self,pcm):
        self.wake.reset();hits=[]
        for i in range(0,len(pcm),1280):
            if self.wake.accept(pcm[i:i+1280]):hits.append(i/32000)
        return hits
    def test_recorded_quiet_calls(self):
        fixture=ROOT/'artifacts/hq/wake-diagnostic.wav'
        if not fixture.exists():self.skipTest('Local private regression recording unavailable')
        with wave.open(str(fixture)) as f:pcm=f.readframes(f.getnframes())
        hits=self.hits(pcm)
        self.assertEqual(len(hits),2,hits)
        self.assertTrue(13<hits[0]<15,hits)
        self.assertTrue(22<hits[1]<24,hits)
    def test_recording_over_odd_http_reads(self):
        fixture=ROOT/'artifacts/hq/wake-diagnostic.wav'
        if not fixture.exists():self.skipTest('Local private regression recording unavailable')
        with wave.open(str(fixture)) as f:pcm=f.readframes(f.getnframes())
        framing=PcmFrames();self.wake.reset();offset=0;hits=0;reconstructed=[]
        for size in itertools.cycle([511,1537,4095,1]):
            if offset>=len(pcm):break
            for frame in framing.accept(pcm[offset:offset+size]):
                reconstructed.append(frame)
                hits+=bool(self.wake.accept(frame))
            offset+=size
        self.assertEqual(b''.join(reconstructed)+framing.pending,pcm)
        self.assertEqual(hits,2)
    @unittest.skipUnless(sys.platform=='darwin' and shutil.which('ffmpeg'),'Uses macOS speech fixtures')
    def test_addressing_and_confusers(self):
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)
            cases=[('Alfred',True),('Hey Alfred, what is your battery level?',True),('Thank you.',False),('I am here whenever you need me sir.',False),('All right.',False),('I offered to help.',False),('Albert, are you there?',False),('Alfredo sauce.',False),('I am Alfred at your service.',False)]
            for voice in ['Daniel','Samantha']:
                for text,expected in cases:
                    with self.subTest(voice=voice,text=text):
                        subprocess.run(['say','-v',voice,'-o',str(path/'clip.aiff'),text],check=True)
                        subprocess.run(['ffmpeg','-loglevel','error','-y','-i',str(path/'clip.aiff'),'-ar','16000','-ac','1',str(path/'clip.wav')],check=True)
                        with wave.open(str(path/'clip.wav')) as f:pcm=f.readframes(f.getnframes())+bytes(32000)
                        self.assertEqual(bool(self.hits(pcm)),expected)
if __name__=='__main__':unittest.main()
