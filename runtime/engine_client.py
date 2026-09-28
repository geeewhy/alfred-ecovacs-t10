"""Authenticated direct-LAN client for Alfred's engine; no ADB tunnel."""
import http.client,json,os,pathlib,urllib.parse
ROOT=pathlib.Path(__file__).resolve().parents[1]
class EngineClient:
    def __init__(self,robot=None):
        config=json.loads((ROOT/'robot.json').read_text())
        self.address=urllib.parse.urlparse(os.environ.get('ALFRED_ENGINE_URL','http://'+config['wifi_address']+':8765'))
        self.token=(ROOT/'artifacts/engine-token').read_text().strip()
    def health(self):return self._request('GET','/health')
    def play_ogg(self,path):
        path=pathlib.Path(path)
        with path.open('rb') as source:return self._request('POST','/v1/audio/play',source,path.stat().st_size,{'Content-Type':'audio/ogg'})
    def _request(self,method,path,body=None,length=None,headers=None):
        connection=http.client.HTTPConnection(self.address.hostname,self.address.port,timeout=15)
        request_headers=dict(headers or {});request_headers['Authorization']='Bearer '+self.token
        if length is not None:request_headers['Content-Length']=str(length)
        try:
            connection.request(method,path,body=body,headers=request_headers)
            response=connection.getresponse();payload=json.loads(response.read())
            if response.status>=400 or not payload.get('ok'):raise RuntimeError(payload.get('result','Engine request failed'))
            return payload['result']
        finally:connection.close()
