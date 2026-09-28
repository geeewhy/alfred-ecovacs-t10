#!/usr/bin/env python3
"""Atomically deploy the cross-compiled Alfred engine and writable boot hook."""
import hashlib,http.server,pathlib,shlex,socket,sys,threading,os,secrets

ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot,CONFIG

BINARY=ROOT/'engine/target/aarch64-unknown-linux-musl/release/alfred-engine'

class TransferServer(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # Avoid HTTPServer's reverse-DNS lookup blocking local deployment.
        super(http.server.HTTPServer,self).server_bind()
        self.server_name=self.server_address[0]
        self.server_port=self.server_address[1]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path!='/alfred-engine':self.send_error(404);return
        self.send_response(200);self.send_header('Content-Length',str(BINARY.stat().st_size));self.end_headers()
        with BINARY.open('rb') as source:
            while chunk:=source.read(65536):self.wfile.write(chunk)
    def log_message(self,*args):pass

def main():
    if not BINARY.is_file():raise RuntimeError('Build the engine before deployment')
    token=ROOT/'artifacts/engine-token'
    if not token.exists():
        token.parent.mkdir(parents=True,exist_ok=True)
        fd=os.open(token,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as output:output.write(secrets.token_hex(32)+'\n')
    robot=Robot();robot.shell('mkdir -p /data/alfred')
    robot.upload(token,'/data/alfred/engine-token')
    robot.shell('chmod 600 /data/alfred/engine-token')
    for script in ('lidar_start.py','map_bridge.py'):
        robot.upload(ROOT/'runtime'/script,'/data/alfred/'+script)
    robot.upload(ROOT/'setup/rolling_log.py','/data/alfred/rolling_log.py')
    robot.upload(ROOT/'setup/adb_supervisor.py','/data/alfred/adb_supervisor.py')
    robot.upload(ROOT/'setup/adb-start.sh','/data/alfred/adb-start.sh')
    robot.upload(ROOT/'setup/start_engine.py','/data/alfred/start_engine.py')
    expected=hashlib.md5(BINARY.read_bytes()).hexdigest()
    probe=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);probe.connect((CONFIG['wifi_address'],5555));host=probe.getsockname()[0];probe.close()
    server=TransferServer((host,0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        url=f'http://{host}:{server.server_port}/alfred-engine';temporary='/data/alfred/alfred-engine.new'
        robot.shell('curl -fsS --max-time 15 '+shlex.quote(url)+' -o '+temporary,timeout=15)
        actual=robot.shell('md5sum '+temporary).split()[0]
        if actual!=expected:raise RuntimeError('Engine upload checksum mismatch')
        robot.shell('chmod 700 '+temporary+' /data/alfred/adb-start.sh /data/alfred/start_engine.py; mv '+temporary+' /data/alfred/alfred-engine; killall alfred-engine 2>/dev/null || true; python /data/alfred/start_engine.py; sleep 1; pidof alfred-engine')
    finally:server.shutdown()
    print('Engine deployed and running:',expected)

if __name__=='__main__':main()
