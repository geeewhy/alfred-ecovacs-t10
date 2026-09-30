"""WebRTC speech classification and a two-second non-speech endpoint."""
import webrtcvad
import audioop
from pcm_frames import PcmFrames

class SpeechEndpoint:
    def __init__(self, classifier=None):
        self.classifier=classifier
        self.reset()
    def reset(self):
        self.vad=webrtcvad.Vad(2)
        self.frames=PcmFrames(640)  # 20ms, 16kHz, mono s16
        self.silent_frames=0
        self.voiced_frames=0
    @property
    def ended(self):return self.voiced_frames>=5 and self.silent_frames>=100
    @property
    def silence_seconds(self):return self.silent_frames*.02
    def accept(self,pcm):
        voiced=0
        for frame in self.frames.accept(pcm):
            speech=self.classifier(frame) if self.classifier else self.vad.is_speech(audioop.mul(frame,2,8) if audioop.rms(frame,2)<500 else frame,16000)
            if speech:
                voiced+=1;self.voiced_frames+=1;self.silent_frames=0
            else:self.silent_frames+=1
        return voiced*.02
