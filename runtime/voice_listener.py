#!/usr/bin/env python3
"""Robot DSP PCM -> local Whisper -> JSON utterances. Control via JSON stdin."""
import json,sys,threading,time,audioop,socket,collections,signal
import numpy as np
import mlx_whisper
from mlx_whisper.transcribe import ModelHolder
import mlx.core as mx
import os
MODEL = os.environ.get("ALFRED_STT_MODEL", "mlx-community/whisper-large-v3-turbo")
vocabulary = []
from robot_mic import microphone, SAMPLE_RATE
paused=True
running=True

def stop(signum,frame):
    global running
    running=False
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)

def expired(signum,frame):
    raise TimeoutError('Speech recognition exceeded 15 seconds')
signal.signal(signal.SIGALRM,expired)

def emit(**event):print(json.dumps(event),flush=True)
def controls():
    global paused,running,vocabulary
    for line in sys.stdin:
        try:
            control=json.loads(line)
            paused=bool(control.get('paused',True))
            vocabulary=control.get('vocabulary',vocabulary)
        except Exception:pass
    running=False
threading.Thread(target=controls,daemon=True).start()
emit(status='loading',message='Loading local speech recognition')
signal.alarm(60)
ModelHolder.get_model(MODEL, mx.float16)
# Compile and warm the Metal path before reporting microphone readiness.
mlx_whisper.transcribe(np.zeros(SAMPLE_RATE,dtype=np.float32),path_or_hf_repo=MODEL,language='en',temperature=0)
signal.alarm(0)
try:
    with microphone() as stream:
        emit(status='listening',message='Robot microphone ready. Speak to Alfred.')
        chunks=[];pre=collections.deque(maxlen=8);voice_time=0;silence=0;last_data=time.monotonic();meter_at=last_data;peak=0;byte_count=0
        while running:
            try:data=stream.recv(4096)
            except socket.timeout:
                if time.monotonic()-last_data>5:raise RuntimeError('Robot microphone stopped streaming')
                continue
            if not data:raise RuntimeError('Robot microphone disconnected')
            last_data=time.monotonic()
            data=data[:len(data)//2*2]
            if paused:chunks=[];pre.clear();voice_time=0;silence=0;continue
            duration=len(data)/(SAMPLE_RATE*2)
            level=audioop.rms(data,2)
            peak=max(peak,level);byte_count+=len(data)
            if time.monotonic()-meter_at>=1:
                emit(meter={'rmsPeak':peak,'bytesPerSecond':round(byte_count/(time.monotonic()-meter_at))})
                meter_at=time.monotonic();peak=0;byte_count=0
            talking=level>150
            if not chunks:
                pre.append(data)
                if not talking:continue
                chunks=list(pre);pre.clear();voice_time=duration;silence=0
            else:
                chunks.append(data);voice_time+=duration;silence=0 if talking else silence+duration
            if silence<1.0 and voice_time<8:continue
            audio=b''.join(chunks);chunks=[];voice_time=0;silence=0
            if len(audio)<SAMPLE_RATE:continue
            emit(status='transcribing',message='Transcribing robot audio')
            resampled=audioop.ratecv(audio,2,1,SAMPLE_RATE,16000,None)[0]
            signal.alarm(15)
            started=time.monotonic()
            result=mlx_whisper.transcribe(np.frombuffer(resampled,dtype=np.int16).astype(np.float32)/32768.0,path_or_hf_repo=MODEL,language='en',initial_prompt='Alfred. '+', '.join(vocabulary[:60]),condition_on_previous_text=False,temperature=0)
            signal.alarm(0)
            text=result['text'].strip()
            emit(transcription={'text':text,'seconds':round(len(audio)/(SAMPLE_RATE*2),2),'at':time.time(),'model':MODEL,'inferenceSeconds':round(time.monotonic()-started,3)})
            if not paused and text:
                # Reject Whisper's non-speech segments before dispatching commands.
                segments=result.get('segments',[])
                speech=any(segment.get('no_speech_prob',0)<0.6 and segment.get('avg_logprob',0)>-1.0 and segment.get('compression_ratio',0)<2.4 for segment in segments)
                emit(heard=text, accepted=speech)
                if speech:
                    import re
                    command=re.sub(r'^\s*alfred[\s,:.!-]*','',text,flags=re.I).strip()
                    if command:emit(text=command)
            emit(status='listening',message='Listening. Speak to Alfred.')
except Exception as error:
    emit(status='error',message=str(error));sys.exit(1)
