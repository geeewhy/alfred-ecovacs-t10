"""Robot audio controls. Native TTS uses Baidu cloud; playback is on-device."""
import json,pathlib,shlex,subprocess,tempfile
from engine_client import EngineClient
class AudioEngine:
    def __init__(self,robot):self.robot=robot
    def _audio(self,payload):
        result=json.loads(self.robot.shell('mdsctl audio0 '+shlex.quote(json.dumps(payload,separators=(',',':')))))
        if result.get('ret')!='ok':raise RuntimeError(result)
        return result
    def volume(self,percent=None):
        if percent is None:return self._audio({'todo':'GetVolume'})
        if not 0<=percent<=100:raise ValueError('Volume must be 0–100')
        return self._audio({'todo':'SetVolume','sid':-1,'value':round(percent*16)})
    def stock(self,number):
        return self._audio({'todo':'audio','cmd':'play','file_number':int(number)})
    def play(self,source):
        with tempfile.TemporaryDirectory() as temp:
            clip=pathlib.Path(temp)/'clip.ogg'
            subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),'-ar','16000','-ac','1','-c:a','libvorbis',str(clip)],check=True)
            return EngineClient(self.robot).play_ogg(clip)
    def say(self,text,voice='Samantha',backend='mac'):
        if backend=='native':
            # Explicit opt-in: this binary calls Baidu's network TTS endpoint.
            return self.robot.shell('timeout 12 speech_tts '+shlex.quote(text),timeout=15)
        if backend!='mac':raise ValueError('Unknown speech backend')
        with tempfile.TemporaryDirectory() as temp:
            source=pathlib.Path(temp)/'speech.aiff'
            subprocess.run(['say','-v',voice,'-o',str(source),text],check=True)
            return self.play(source)
