"""Robot DSP PCM over the authenticated engine HTTP connection; no ADB."""
import contextlib
import json
import os
import pathlib
import urllib.request

SAMPLE_RATE = 16000
ROOT = pathlib.Path(__file__).resolve().parents[1]

class AudioStream:
    def __init__(self, response):
        self.response = response
    def recv(self, size):
        return self.response.read1(size)

@contextlib.contextmanager
def microphone():
    robot = json.loads((ROOT / 'robot.json').read_text())
    base = os.environ.get('HQ_ENGINE_URL', 'http://%s:8765' % robot['wifi_address']).rstrip('/')
    token = (ROOT / 'artifacts/engine-token').read_text().strip()
    request = urllib.request.Request(base + '/v1/audio/microphone', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=12) as response:
        yield AudioStream(response)
