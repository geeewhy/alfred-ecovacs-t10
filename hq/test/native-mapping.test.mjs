import test from 'node:test';
import assert from 'node:assert/strict';
import {MapService} from '../src/maps/map-service.mjs';

test('failed navigation startup stops both command owners and pauses native mapping',async()=>{
 const calls=[];
 const engine={stop:async()=>calls.push('stop'),wakeForMapping:async()=>{},lidar:async()=>({result:{sequence:1,points:[]}}),nativeMapping:async action=>{
  calls.push(action);
  if(action==='grid')return {sequence:1,resolution:.05,origin:[0,0],cells:[]};
  if(action==='status')return {boot_id:'boot',pose:{x:0,y:0,theta:0,age_ms:0}};
 }};
 const service=new MapService(engine);
 service.native={call:async()=>({work:{state:0}})};
 service.navigation={call:async action=>{calls.push('nav:'+action);if(action==='start')throw Error('controller unavailable');return {ready:true};}};
 service.checkpoint=async()=>{};
 await assert.rejects(service.nativeScan({id:'test',cells:[],scan:{}},'start',{},0),/controller unavailable/);
 assert.equal(service.active.status.state,'paused');
 assert.deepEqual(calls.slice(-3),['nav:pause','stop','pause']);
});

test('manual stop cancels a companion command lease even after HQ restart',async()=>{
 const calls=[];const service=new MapService({stop:async()=>calls.push('stop')});
 service.navigation={call:async action=>calls.push(action)};
 await service.pauseActive();assert.deepEqual(calls,['pause','stop']);
});

test('Stop during graph preparation cannot start exploration after telemetry resolves',async()=>{
 const calls=[];let release,entered;
 const waiting=new Promise(r=>entered=r),lidar=new Promise(r=>release=r);
 const engine={stop:async()=>calls.push('stop'),wakeForMapping:async()=>{},nativeMapping:async()=>({boot_id:'boot',reports:{'/task/WorkState':{bytes:[0,0,0]}}}),lidar:()=>{entered();return lidar;}};
 const service=new MapService(engine);
 service.checkpoint=async()=>{};
 service.navigation={call:async action=>{
  calls.push(action);
  if(action==='mapping/start')return {location:{state:'idle'}};
  if(action==='grid')return {sequence:1,resolution:.05,origin:[0,0],cells:[[0,0,127]]};
  return {ready:true,mapping:{pose:{x:0,y:0,theta:0,age_ms:0}}};
 }};
 const preparing=service.graphScan({id:'test',cells:[],scan:{}},'start',{},0);
 await waiting;service.epoch++;release({result:{sequence:1,points:[]}});
 await assert.rejects(preparing,/cancelled/);
 assert.ok(!calls.includes('start'));
 assert.equal(service.active.status.state,'paused');
 assert.deepEqual(calls.slice(-2),['mapping/pause','stop']);
});

test('brief mapping fault stops wheels without discarding the scan; persistent fault pauses with its cause',async()=>{
 const calls=[];const service=new MapService({stop:async()=>calls.push('stop'),lidar:async()=>({result:{age_ms:20}})});
 service.schedule=()=>{};service.checkpoint=async()=>{};
 service.active={id:'map',lastStructure:Date.now(),lastGrid:Date.now(),scanner:{},status:{state:'scanning',mode:'explore'}};
 service.navigation={call:async action=>{calls.push(action);return {ready:false,active:true,message:'tracking lost',mapping:{map_id:'map',capture:true,tracking_error:'SLAM stopped matching motion'}};}};
 await service.graphTick();assert.equal(service.active.status.state,'scanning');assert.ok(calls.includes('stop'));assert.ok(!calls.includes('mapping/pause'));
 service.active.telemetryFaultSince=Date.now()-6000;
 await service.graphTick();assert.equal(service.active.status.state,'paused');assert.match(service.active.status.error,/SLAM stopped matching motion/);assert.ok(calls.includes('mapping/pause'));
});

test('explorer exhaustion does not finish a map with disconnected frontiers',async()=>{
 const service=new MapService({stop:async()=>{},lidar:async()=>({result:{age_ms:10}})});
 service.schedule=()=>{};service.checkpoint=async()=>{};
 service.active={id:'map',lastStructure:Date.now(),lastGrid:Date.now(),lastSave:Date.now(),deadline:Date.now()+60000,scanner:{update:()=>({})},status:{state:'scanning',mode:'explore'}};
 service.navigation={call:async()=>({active:true,ready:true,message:'Exploring',exploration:'exploration_complete',failed_goals:0,frontiers:{disconnected:8},mapping:{map_id:'map',capture:true,pose:{x:0,y:0,theta:0}}})};
 await service.graphTick();
 assert.equal(service.active.status.state,'paused');
 assert.equal(service.active.status.unresolvedFrontiers,8);
 assert.match(service.active.status.message,/8 unmapped boundaries/);
});
