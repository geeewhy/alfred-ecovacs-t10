import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EngineClient} from '../src/bot/engine-client.mjs';
test('direct engine authenticates status and stop without ADB',async()=>{
 const seen=[];const server=http.createServer((req,res)=>{seen.push([req.method,req.url,req.headers.authorization]);res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result:'ok'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const c=new EngineClient(`http://127.0.0.1:${server.address().port}`,'test-token');await c.connect();await c.stop();assert.deepEqual(seen,[['GET','/health','Bearer test-token'],['POST','/v1/drive/stop','Bearer test-token']]);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('uncertain direct motion is not retried',async()=>{
 let calls=0;const server=http.createServer((req)=>{calls++;req.socket.destroy();});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const c=new EngineClient(`http://127.0.0.1:${server.address().port}`,'test-token');await assert.rejects(c.drive({linear:0,angular:0}));assert.equal(calls,1);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('fresh charging query uses host time despite robot clock skew',async()=>{
 const c=new EngineClient('http://unused','token');
 c.request=async()=>({ok:true,json:async()=>({ok:true,result:{docked:false,observedAt:Date.now()-60000}})});
 const before=Date.now(),dock=await c.dockStatus();
 assert.ok(dock.observedAt>=before && dock.observedAt<=Date.now());
 assert.ok(dock.observedAt-dock.sourceObservedAt>=59000);
});
