import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {HqServer} from '../src/http/server.mjs';

test('cockpit stops before slow cleanup and never queues a drive behind it',async()=>{
  const calls=[];let finishCleanup,entered;
  const cleaning=new Promise(r=>entered=r);
  const pending=new Promise(r=>finishCleanup=r);
  const h=Object.create(HqServer.prototype);
  h.engineClient={stop:async()=>{calls.push('stop');return {ok:true};},drive:async()=>{calls.push('drive');return {ok:true};}};
  h.maps={stopExploration:async()=>{calls.push('cleanup');entered();await pending;},prepareManualDrive:()=>{},exploring:false};
  const server=createServer(h.handle.bind(h));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}/api/bots/alfred/drive`;
  try{
    const stop=fetch(base+'/stop',{method:'POST'});
    await cleaning;assert.deepEqual(calls,['stop','cleanup']);
    const blocked=await fetch(base,{method:'PUT',headers:{'content-type':'application/json'},body:'{"linear":0.1,"angular":0}'});
    assert.equal(blocked.status,503);assert.deepEqual(calls,['stop','cleanup']);
    finishCleanup();assert.equal((await stop).status,200);
    const fresh=await fetch(base,{method:'PUT',headers:{'content-type':'application/json'},body:'{"linear":0.1,"angular":0}'});
    assert.equal(fresh.status,200);assert.deepEqual(calls,['stop','cleanup','drive']);
  }finally{finishCleanup();await new Promise(r=>server.close(r));}
});
