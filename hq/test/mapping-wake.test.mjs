import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineClient} from '../src/bot/engine-client.mjs';

test('mapping wakes a stopped LiDAR and requires a new fresh frame',async()=>{
 const calls=[];const engine=new EngineClient('http://robot:8765','test');
 engine.request=async path=>{calls.push(path);return {ok:true};};
 let n=0;engine.lidar=async()=>({result:++n===1?{sequence:1,age_ms:60000}:{sequence:2,age_ms:10}});
 await engine.ensureMappingLidar();
 assert.equal(calls.length,1);assert.equal(n,2);
});

test('fresh mapping LiDAR needs no firmware mutation',async()=>{
 const engine=new EngineClient('http://robot:8765','test');
 engine.lidar=async()=>({result:{sequence:5,age_ms:20}});
 await engine.ensureMappingLidar();
});
