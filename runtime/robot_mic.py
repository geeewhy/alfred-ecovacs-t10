"""Exclusive native DSP microphone over authenticated ADB; no Mac microphone."""
import contextlib, fcntl, hashlib, os, pathlib, shlex, socket, subprocess, tempfile, time
from alfred import Robot, ENV

SAMPLE_RATE = 16000

@contextlib.contextmanager
def microphone():
    robot = Robot()
    stream = None
    local = None
    pid = None
    lock = open(os.path.join(tempfile.gettempdir(), 'alfred-microphone.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source = pathlib.Path(__file__).with_name('robot_mic_server.py')
        destination = '/data/alfred/robot_mic_server.py'
        digest = hashlib.md5(source.read_bytes()).hexdigest()
        actual = robot.shell('if test -f '+destination+'; then md5sum '+destination+'; fi').split()
        if not actual or actual[0] != digest:
            robot.upload(source, destination)
        result = subprocess.run(['adb','-s',robot.serial,'forward','tcp:0','tcp:8082'],env=ENV,check=True,capture_output=True,timeout=15)
        port = int(result.stdout.decode().strip())
        local = 'tcp:' + str(port)
        code = '''import subprocess,os
p=subprocess.Popen(['python',%r],stdin=open('/dev/null'),stdout=open('/tmp/alfred-microphone.log','a'),stderr=subprocess.STDOUT,preexec_fn=os.setsid)
print(p.pid)
''' % destination
        pid = int(robot.shell('python -c '+shlex.quote(code)).strip())
        for attempt in range(5):
            try:
                stream = socket.create_connection(('127.0.0.1',port),1)
                stream.settimeout(5)
                stream.sendall(b'record')
                # ADB can accept before the device listener is ready; verify PCM.
                if not stream.recv(2, socket.MSG_PEEK):
                    raise OSError('Robot microphone closed during startup')
                stream.settimeout(1)
                break
            except OSError:
                if stream: stream.close()
                if attempt == 4: raise
                time.sleep(1)
        yield stream
    finally:
        if stream: stream.close()
        if local:
            subprocess.run(['adb','-s',robot.serial,'forward','--remove',local],env=ENV,capture_output=True,timeout=15)
        # The server also restores DSP ownership on socket disconnect, so cleanup
        # does not rely on a later successful ADB command after a network loss.
        if pid:
            try: robot.shell('kill -TERM %d 2>/dev/null || true' % pid)
            finally: lock.close()
        else: lock.close()
