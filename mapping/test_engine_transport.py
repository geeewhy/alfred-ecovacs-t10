"""Exercise the adapter transport without loading ROS dependencies."""
import ast,http.client,json,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

class EngineTransport(unittest.TestCase):
    def transport(self,verb):
        old=Mock();old.getresponse.side_effect=http.client.RemoteDisconnected('closed')
        fresh=Mock();fresh.getresponse.return_value.read.return_value=b'{"ok":true,"result":{"fresh":true}}'
        factory=Mock(return_value=fresh)
        env={'TOKEN':'test-token','LOCAL':threading.local(),'ADDRESS':SimpleNamespace(hostname='engine',port=8765),
             'http':SimpleNamespace(client=SimpleNamespace(HTTPConnection=factory,HTTPException=http.client.HTTPException)),
             'socket':SimpleNamespace(gethostbyname=lambda host:host),'json':json}
        env['LOCAL'].connection=old
        tree=ast.parse(Path(__file__).with_name('bridge.py').read_text())
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='request')
        exec(compile(ast.Module(body=[function],type_ignores=[]),'bridge.py','exec'),env)
        return env['request'],old,fresh,factory
    def test_closed_keepalive_read_gets_fresh_response(self):
        request,old,fresh,factory=self.transport('GET')
        self.assertEqual(request('/frame'),{'fresh':True})
        old.close.assert_called_once();factory.assert_called_once()
        self.assertEqual(fresh.request.call_args.args[0],'GET')
    def test_uncertain_motion_is_never_replayed(self):
        request,old,fresh,factory=self.transport('PUT')
        with self.assertRaises(http.client.RemoteDisconnected):request('/twist',{'speed':100},'PUT')
        factory.assert_not_called();old.close.assert_called_once()
    def test_repeated_read_failure_is_bounded(self):
        request,old,fresh,factory=self.transport('GET')
        fresh.getresponse.side_effect=TimeoutError('timeout')
        with self.assertRaises(TimeoutError):request('/frame')
        factory.assert_called_once();fresh.close.assert_called_once()

if __name__=='__main__':unittest.main()
