import http.server
import json
import pathlib
import tempfile
import threading
import unittest
from unittest.mock import patch
import robot_mic

class MicrophoneTransportTest(unittest.TestCase):
    def test_authenticated_http_pcm_and_reconnect_without_adb(self):
        requests = []
        pcm = b'\x01\x00\xff\x7f' * 2048
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get('Authorization')))
                self.send_response(200)
                self.send_header('Content-Length', str(len(pcm)))
                self.end_headers()
                self.wfile.write(pcm)
            def log_message(self, *args): pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                (root / 'robot.json').write_text(json.dumps({'wifi_address':'unused'}))
                (root / 'artifacts').mkdir()
                (root / 'artifacts/engine-token').write_text('test-token\n')
                with patch.object(robot_mic, 'ROOT', root), patch.dict('os.environ', {'HQ_ENGINE_URL':'http://127.0.0.1:%d' % server.server_port}), patch('subprocess.run', side_effect=AssertionError('No ADB allowed')):
                    for _ in range(2):
                        with robot_mic.microphone() as stream:
                            actual = b''
                            while True:
                                chunk = stream.recv(2048)
                                if not chunk: break
                                actual += chunk
                            self.assertEqual(actual, pcm)
            self.assertEqual(requests, [('/v1/audio/microphone','Bearer test-token')] * 2)
        finally:
            server.shutdown(); server.server_close()

if __name__ == '__main__': unittest.main()
