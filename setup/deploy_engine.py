#!/usr/bin/env python3
"""Atomically deploy the cross-compiled Alfred engine and writable boot hook."""
import hashlib,http.server,pathlib,shlex,socket,sys,threading

ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot,CONFIG

BINARY=ROOT/'engine/target/aarch64-unknown-linux-musl/release/alfred-engine'

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path!='/alfred-engine':self.send_error(404);return
        self.send_response(200);self.send_header('Content-Length',str(BINARY.stat().st_size));self.end_headers()
        with BINARY.open('rb') as source:
            while chunk:=source.read(65536):self.wfile.write(chunk)
    def log_message(self,*args):pass

def main():
    if not BINARY.is_file():raise RuntimeError('Build the engine before deployment')
    robot=Robot();robot.shell('mkdir -p /data/alfred')
    robot.upload(ROOT/'setup/adb-start.sh','/data/alfred/adb-start.sh')
    robot.upload(ROOT/'setup/start_engine.py','/data/alfred/start_engine.py')
    expected=hashlib.md5(BINARY.read_bytes()).hexdigest()
    probe=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);probe.connect((CONFIG['wifi_address'],5555));host=probe.getsockname()[0];probe.close()
    server=http.server.ThreadingHTTPServer((host,0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        url=f'http://{host}:{server.server_port}/alfred-engine';temporary='/data/alfred/alfred-engine.new'
        robot.shell('curl -fsS --max-time 60 '+shlex.quote(url)+' -o '+temporary,timeout=65)
        actual=robot.shell('md5sum '+temporary).split()[0]
        if actual!=expected:raise RuntimeError('Engine upload checksum mismatch')
        robot.shell('chmod 700 '+temporary+' /data/alfred/adb-start.sh /data/alfred/start_engine.py; mv '+temporary+' /data/alfred/alfred-engine; killall alfred-engine 2>/dev/null || true; python /data/alfred/start_engine.py; sleep 1; pidof alfred-engine')
    finally:server.shutdown()
    print('Engine deployed and running:',expected)

if __name__=='__main__':main()
