"""Local, fixed-grammar Alfred wake detection with quiet-mic conditioning.

No Whisper or chat inference here. The unknown-word path competes with Alfred;
only an addressed name with sufficient confidence/duration opens the listener.
"""
from pathlib import Path
import audioop
import collections
import json
import vosk

ROOT=Path(__file__).resolve().parents[1]
MODEL='vosk-model-small-en-us-0.15'

class WakeWord:
    def __init__(self):
        vosk.SetLogLevel(-1)
        self.model=vosk.Model(str(ROOT/'artifacts/voice-models'/MODEL))
        self.reset()

    def reset(self):
        self.pre=collections.deque(maxlen=10)
        self.chunks=[]
        self.pending=b''
        self.noise=7.0
        self.silence=0
        self.voiced=0
        self.since_check=0
        self.confirmations=0

    def _recognized(self, pcm):
        rms=audioop.rms(pcm,2)
        peak=audioop.max(pcm,2)
        # One gain for the bounded utterance, capped both by gain and headroom.
        gain=min(80.0,2000/max(1,rms),28000/max(1,peak))
        pcm=audioop.mul(pcm,2,gain)
        decoder=vosk.KaldiRecognizer(self.model,16000,
            '["alfred", "hey alfred", "i am alfred", "this is alfred", "[unk]"]')
        decoder.SetWords(True)
        decoder.AcceptWaveform(pcm)
        words=json.loads(decoder.FinalResult()).get('result',[])
        # A sub-120ms boundary fragment is not a preceding spoken phrase.
        if words and words[0]['word']=='[unk]' and words[0]['end']-words[0]['start']<.12:
            words=words[1:]
        if words and words[0]['word']=='hey':words=words[1:]
        if not words or words[0]['word']!='alfred':return False
        name=words[0]
        return name.get('conf',0)>=.85 and .2<=name['end']-name['start']<=1.1

    def accept(self, pcm):
        self.pending+=pcm
        while len(self.pending)>=640:
            frame,self.pending=self.pending[:640],self.pending[640:]
            level=audioop.rms(frame,2)
            talking=level>max(15,self.noise*3)
            if not self.chunks:
                self.pre.append(frame)
                if not talking:
                    self.noise=.98*self.noise+.02*min(level,self.noise*1.5)
                    continue
                self.chunks=list(self.pre);self.pre.clear()
            else:self.chunks.append(frame)
            self.voiced+=.02 if talking else 0
            self.silence=0 if talking else self.silence+.02
            self.since_check+=.02
            finished=self.silence>=.3 or len(self.chunks)>=150
            if self.voiced>=.12 and (finished or (len(self.chunks)>=25 and self.since_check>=.16)):
                matched=self._recognized(b''.join(self.chunks))
                self.since_check=0
                self.confirmations=self.confirmations+1 if matched else 0
                if matched and (finished or self.confirmations>=2):
                    self.reset()
                    return True
            if finished:
                self.chunks=[];self.voiced=0;self.silence=0;self.since_check=0;self.confirmations=0
        return False
