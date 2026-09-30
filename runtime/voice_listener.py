#!/usr/bin/env python3
"""Robot DSP PCM -> local Whisper -> JSON utterances. Control via JSON stdin."""
import json,sys,threading,time,audioop,socket,collections,signal,queue
import numpy as np
import mlx_whisper
from mlx_whisper.transcribe import ModelHolder
import mlx.core as mx
import os
MODEL = os.environ.get("ALFRED_STT_MODEL", "mlx-community/whisper-large-v3-turbo")
vocabulary = []
from robot_mic import microphone, SAMPLE_RATE
from voice_gate import addressed_command
from wake_word import WakeWord
from pcm_frames import PcmFrames
from speech_endpoint import SpeechEndpoint
paused=True
running=True
epoch=0
audio_queue=queue.Queue(maxsize=8)

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
    global paused,running,vocabulary,epoch
    for line in sys.stdin:
        try:
            control=json.loads(line)
            new_paused=bool(control.get('paused',True))
            if new_paused != paused:epoch += 1
            paused=new_paused
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
wake=WakeWord()
endpoint=SpeechEndpoint()
awake_until=0
try:
    with microphone() as stream:
        emit(status='listening',message='Say Alfred to wake me.')
        capture_stats={"reads":0,"oddReads":0,"droppedFrames":0}
        def capture():
            framing=PcmFrames()
            # Opt-in, bounded diagnostic recording for wake-detector replay.
            import wave
            recording=None
            seconds=min(60,max(0,float(os.environ.get('ALFRED_VOICE_CAPTURE_SECONDS','0'))))
            remaining=int(seconds*SAMPLE_RATE*2)
            if remaining:
                recording=wave.open(str(__import__('pathlib').Path(__file__).resolve().parents[1]/'artifacts/hq/wake-diagnostic.wav'),'wb')
                recording.setnchannels(1);recording.setsampwidth(2);recording.setframerate(SAMPLE_RATE)
            # Always drain the transport, including during model inference/playback.
            while running:
                try:
                    read_epoch=epoch
                    data=stream.recv(4096)
                    if not data:raise RuntimeError('Robot microphone disconnected')
                except Exception as error:
                    try:audio_queue.put_nowait((time.monotonic(),epoch,error))
                    except queue.Full:pass
                    return
                if recording:
                    recording.writeframes(data[:remaining]);remaining-=len(data)
                    if remaining<=0:recording.close();recording=None
                capture_stats['reads']+=1
                capture_stats['oddReads']+=len(data)%2
                # Preserve every byte across HTTP read boundaries, even while paused.
                for frame in framing.accept(data):
                    if paused or read_epoch != epoch:continue
                    item=(time.monotonic(),epoch,frame)
                    try:audio_queue.put_nowait(item)
                    except queue.Full:
                        capture_stats['droppedFrames']+=1
                        try:audio_queue.get_nowait()
                        except queue.Empty:pass
                        try:audio_queue.put_nowait(item)
                        except queue.Full:pass
        threading.Thread(target=capture,daemon=True).start()
        capture_epoch=epoch
        chunks=[];pre=collections.deque(maxlen=32);speech_time=0;voice_time=0;silence=0;last_data=time.monotonic();meter_at=last_data;peak=0;byte_count=0
        while running:
            try:captured,frame_epoch,data=audio_queue.get(timeout=1)
            except queue.Empty:
                if paused:last_data=time.monotonic()
                if not paused and time.monotonic()-last_data>15:raise RuntimeError('Robot microphone stopped streaming')
                continue
            if not data:raise RuntimeError('Robot microphone disconnected')
            if isinstance(data,Exception):raise data
            last_data=time.monotonic()
            if frame_epoch != epoch or captured < last_data-.3:
                chunks=[];pre.clear();speech_time=0;voice_time=0;silence=0;endpoint.reset()
                continue
            if capture_epoch != frame_epoch:
                chunks=[];pre.clear();speech_time=0;voice_time=0;silence=0;endpoint.reset()
                capture_epoch=frame_epoch
                awake_until=0;wake.reset()
            if paused:chunks=[];pre.clear();speech_time=0;voice_time=0;silence=0;endpoint.reset();continue
            duration=len(data)/(SAMPLE_RATE*2)
            level=audioop.rms(data,2)
            peak=max(peak,level);byte_count+=len(data)
            if time.monotonic()-meter_at>=1:
                emit(meter={'rmsPeak':peak,'bytesPerSecond':round(byte_count/(time.monotonic()-meter_at)),**capture_stats})
                meter_at=time.monotonic();peak=0;byte_count=0
            if not awake_until or (time.monotonic()>awake_until and speech_time<.1):
                if awake_until:
                    chunks=[];pre.clear();speech_time=0;voice_time=0;silence=0;endpoint.reset()
                    emit(status='listening',message='Say Alfred to wake me.')
                    awake_until=0;wake.reset()
                pre.append(data)
                if not wake.accept(data):continue
                awake_until=time.monotonic()+8
                emit(wake=True,status='awake',message='Listening for your request…')
                chunks=list(pre);pre.clear();voice_time=0;silence=0;endpoint.reset()
            voiced_duration=endpoint.accept(data)
            talking=voiced_duration>0
            speech_time+=voiced_duration
            if not chunks:
                pre.append(data)
                if not talking:continue
                chunks=list(pre);pre.clear();voice_time=duration;silence=0
            else:
                chunks.append(data);voice_time+=duration;silence=0 if talking else silence+duration
            if not endpoint.ended and voice_time<30:continue
            end_silence=endpoint.silence_seconds
            audio=b''.join(chunks);chunks=[];voice_time=0;silence=0;endpoint.reset()
            voiced=speech_time;speech_time=0
            if len(audio)<SAMPLE_RATE or voiced<.1:continue
            emit(status='transcribing',message='Transcribing robot audio')
            resampled=audioop.ratecv(audio,2,1,SAMPLE_RATE,16000,None)[0]
            signal.alarm(15)
            started=time.monotonic()
            result=mlx_whisper.transcribe(np.frombuffer(resampled,dtype=np.int16).astype(np.float32)/32768.0,path_or_hf_repo=MODEL,language='en',initial_prompt=', '.join(vocabulary[:60]) or None,condition_on_previous_text=False,temperature=0)
            signal.alarm(0)
            text=result['text'].strip()
            emit(transcription={'text':text,'seconds':round(len(audio)/(SAMPLE_RATE*2),2),'at':time.time(),'model':MODEL,'inferenceSeconds':round(time.monotonic()-started,3),'endpointSilenceSeconds':round(end_silence,2),'endpoint':'webrtc-vad'})
            if not paused and capture_epoch == epoch and text:
                command=addressed_command(text,result.get('segments',[]),awakened=True)
                emit(heard=text, accepted=command is not None)
                if command:
                    emit(text=command)
                    awake_until=0;wake.reset()
                elif command is None:
                    awake_until=0;wake.reset()
            emit(status='awake' if awake_until else 'listening',message='Listening for your request…' if awake_until else 'Say Alfred to wake me.')
except Exception as error:
    emit(status='error',message=str(error));sys.exit(1)
