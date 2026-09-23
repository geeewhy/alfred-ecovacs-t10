"""HTTP client for the loopback-only Alfred engine over authenticated ADB."""
import contextlib,http.client,json,os,pathlib,socket,subprocess

ENV=dict(os.environ,ADB_LIBUSB='0')
REMOTE_PORT=8765

class EngineClient:
    def __init__(self,robot):self.robot=robot

    @contextlib.contextmanager
    def _connection(self):
        reservation=socket.socket();reservation.bind(('127.0.0.1',0))
        port=reservation.getsockname()[1];reservation.close()
        local='tcp:'+str(port)
        subprocess.run(['adb','-s',self.robot.serial,'forward',local,'tcp:'+str(REMOTE_PORT)],env=ENV,check=True,capture_output=True,timeout=15)
        try:
            yield port
        finally:
            subprocess.run(['adb','-s',self.robot.serial,'forward','--remove',local],env=ENV,capture_output=True,timeout=15)

    def health(self):return self._request('GET','/health')

    def play_ogg(self,path):
        path=pathlib.Path(path);length=path.stat().st_size
        with path.open('rb') as source:return self._request('POST','/v1/audio/play',source,length,{'Content-Type':'audio/ogg'})

    def _request(self,method,path,body=None,length=None,headers=None):
        with self._connection() as port:
            connection=http.client.HTTPConnection('127.0.0.1',port,timeout=15)
            request_headers=dict(headers or {})
            if length is not None:request_headers['Content-Length']=str(length)
            connection.request(method,path,body=body,headers=request_headers)
            response=connection.getresponse();payload=json.loads(response.read())
            connection.close()
            if response.status>=400 or not payload.get('ok'):raise RuntimeError(payload.get('result','Engine request failed'))
            return payload['result']
