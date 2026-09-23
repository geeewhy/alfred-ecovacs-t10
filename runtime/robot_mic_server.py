#!/usr/bin/env python
"""Robot-side, single-client 16 kHz PCM bridge. Compatible with firmware Python 2.

Uses the same TalkClient as audio_record, retaining all mono samples. The stock
recorder incorrectly selects every other sample on this firmware. Holds sole
DSP ownership only while a host is connected; restores the assistant on exit.
"""
import ctypes, os, signal, socket, subprocess, time

def terminate(signum, frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', 8082))
listener.listen(1)
listener.settimeout(5)
paused = []
service = None
client = None
sdk = None
instance = None
try:
    ids = subprocess.Popen(['pidof', 'speech_inter_client'], stdout=subprocess.PIPE).communicate()[0].split()
    for value in ids:
        pid = int(value)
        if open('/proc/%s/stat' % pid).read().split()[2] not in ('T', 't'):
            os.kill(pid, signal.SIGSTOP)
            paused.append(pid)
    if subprocess.call(['pidof', 'bds_audio_service'], stdout=open('/dev/null', 'w')) == 0:
        raise RuntimeError('Another DSP recording service is running')
    service = subprocess.Popen(['/usr/bin/bds_audio_service', 'hw:0,0'], stdin=open('/dev/null'), stdout=open('/tmp/alfred-bds_audio_service.log', 'a'), stderr=subprocess.STDOUT)
    time.sleep(1)
    ctypes.CDLL('/usr/lib/libaudrpc_spil.so', mode=ctypes.RTLD_GLOBAL)
    ctypes.CDLL('/usr/lib/libbd_alsa_audio_client.so', mode=ctypes.RTLD_GLOBAL)
    sdk = ctypes.CDLL('/usr/lib/libBDSpeechSDK.so')
    factory = getattr(sdk, '_ZN5baidu6speech6client10TalkClient15create_instanceEv')
    factory.restype = ctypes.c_void_p
    instance = factory()
    if not instance:
        raise RuntimeError('Could not create firmware microphone client')
    start = getattr(sdk, '_ZN5baidu6speech6client8TalkImpl5startEv')
    read = getattr(sdk, '_ZN5baidu6speech6client8TalkImpl10read_audioEPci')
    stop = getattr(sdk, '_ZN5baidu6speech6client8TalkImpl4stopEv')
    start.argtypes = stop.argtypes = [ctypes.c_void_p]
    read.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
    start(instance)
    client, address = listener.accept()
    client.settimeout(3)
    if client.recv(16) != b'record':
        raise RuntimeError('Invalid recording request')
    buffer = ctypes.create_string_buffer(2048)
    while True:
        # The native read returns zero on success and fills the requested bytes.
        if read(instance, buffer, len(buffer)) < 0:
            raise RuntimeError('Firmware microphone read failed')
        client.sendall(buffer.raw)
finally:
    if client: client.close()
    listener.close()
    if instance:
        stop(instance)
    if service:
        service.terminate()
        service.wait()
    for pid in paused:
        try: os.kill(pid, signal.SIGCONT)
        except OSError: pass
