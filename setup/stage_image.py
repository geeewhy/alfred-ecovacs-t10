#!/usr/bin/env python3
"""Transfer verified image to /data; no flash writes."""
import hashlib,http.server,pathlib,shlex,socket,sys,threading
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot,CONFIG
image=ROOT/'artifacts/firmware/rootfs-autostart-1.11.0.squashfs'
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path!='/image':self.send_error(404);return
        self.send_response(200);self.send_header('Content-Length',str(image.stat().st_size));self.end_headers()
        with image.open('rb') as f:
            while chunk:=f.read(65536):self.wfile.write(chunk)
    def log_message(self,*args):pass
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.connect((CONFIG['wifi_address'],5555));host=s.getsockname()[0];s.close()
server=http.server.ThreadingHTTPServer((host,0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    r=Robot();target='/tmp/alfred-rootfs.squashfs'
    r.shell('curl -fsS --max-time 300 '+shlex.quote(f'http://{host}:{server.server_port}/image')+' -o '+target,timeout=305)
    expected=hashlib.md5(image.read_bytes()).hexdigest();actual=r.shell('md5sum '+target).split()[0];assert actual==expected
    r.shell('cp /tmp/alfred-rootfs.squashfs /data/alfred/rootfs-autostart.squashfs; sync',timeout=300)
    assert r.shell('md5sum /data/alfred/rootfs-autostart.squashfs',timeout=30).split()[0]==expected
    print('Staged image checksum verified:',actual)
finally:server.shutdown()
