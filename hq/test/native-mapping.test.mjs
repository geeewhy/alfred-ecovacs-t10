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

test('explorer exhaustion does not finish a map with reachable frontiers still awaiting a route',async()=>{
 const service=new MapService({stop:async()=>{},lidar:async()=>({result:{age_ms:10}})});
 service.schedule=()=>{};service.checkpoint=async()=>{};
 service.active={id:'map',lastStructure:Date.now(),lastGrid:Date.now(),lastSave:Date.now(),deadline:Date.now()+60000,scanner:{update:()=>({})},status:{state:'scanning',mode:'explore'}};
 service.navigation={call:async()=>({active:true,ready:true,message:'Exploring',exploration:'exploration_complete',failed_goals:0,frontiers:{disconnected:0,reachable:3,total:3},mapping:{map_id:'map',capture:true,pose:{x:0,y:0,theta:0}}})};
 await service.graphTick();
 assert.equal(service.active.status.state,'paused');
 assert.equal(service.active.status.unresolvedFrontiers,3);
 assert.match(service.active.status.message,/3 unmapped boundaries/);
});


test('deep pass stays resumable when frontier planning ends before every section is checked',async()=>{
 const service=new MapService({stop:async()=>{},lidar:async()=>({result:{age_ms:10}})});
 service.schedule=()=>{};service.checkpoint=async()=>{};
 service.active={id:'map',lastStructure:Date.now(),lastGrid:Date.now(),lastSave:Date.now(),deadline:Date.now()+60000,scanner:{update:()=>({})},status:{state:'scanning',mode:'explore',deep:true}};
 service.navigation={call:async()=>({active:true,ready:true,message:'Exploring',exploration:'exploration_complete',failed_goals:0,frontiers:{disconnected:0,total:0},deep_pass:{total:4,verified:1,remaining:3,targets:[]},mapping:{map_id:'map',capture:true,pose:{x:0,y:0,theta:0}}})};
 await service.graphTick();
 assert.equal(service.active.status.state,'paused');
 assert.equal(service.active.status.deepPass.remaining,3);
 assert.match(service.active.status.message,/1\/4 sections checked/);
});

test('map reads expose the current location operation instead of a stale saved pause',async()=>{
 const service=new MapService({});
 service.load=async()=>({id:'map',cells:[],scan:{state:'paused'},checkpoint:{backend:'slam_toolbox'}});
 service.active={id:'map',station:{x:1,y:2},status:{state:'locating'},scanner:{grid:()=>[]}};
 const result=await service.get('map');
 assert.equal(result.scan.state,'locating');assert.equal(result.station.x,1);
});

test('repeated Locate reuses the pending search and failure clears its operation',async()=>{
 const service=new MapService({stop:async()=>{},lidar:async()=>({result:{age_ms:10}})});
 service.schedule=()=>{};service.checkpoint=async()=>{};
 service.get=async()=>({scan:service.active.status});
 service.active={id:'map',pendingAction:'locate',lastStructure:Date.now(),lastGrid:Date.now(),scanner:{},status:{state:'locating',localization:'locating'}};
 assert.equal((await service.graphScan({id:'map'},'locate',{},0)).scan.state,'locating');
 service.navigation={call:async()=>({mapping:{location:{state:'failed',message:'No stable match'}}})};
 await service.graphTick();
 assert.equal(service.active.status.state,'paused');
 assert.equal(service.active.status.localization,'failed');
 assert.equal(service.active.pendingAction,null);
});

test('station telemetry failure does not discard a verified map position',async()=>{
 const service=new MapService({dockStatus:async()=>{throw Error('ADB unavailable');}});
 service.navigation={call:async()=>{}};
 const active={stationRequested:true,pendingAction:'locate',status:{state:'locating',pose:{x:1,y:2,theta:0}}};
 await service.completeGraphLocation(active);
 assert.equal(active.status.state,'paused');assert.equal(active.status.localization,'located');
 assert.equal(active.status.error,null);assert.equal(active.pendingAction,null);
 assert.match(active.status.message,/Station detection unavailable/);
 assert.equal(active.station,undefined);
});

test('Locate preserves the saved deep-pass configuration despite toolbar defaults',async()=>{
 const service=new MapService({wakeForMapping:async()=>{},nativeMapping:async()=>({reports:{'/task/WorkState':{bytes:[0,0,0]}}})});
 service.navigation={call:async()=>({location:{state:'locating',message:'Finding position'}})};
 service.checkpoint=async()=>{};service.schedule=()=>{};service.get=async()=>service.active.status;
 const deepPass={total:3,remaining:2,verified:1,targets:[]};
 const status=await service.graphScan({id:'map',checkpoint:{},scan:{mode:'explore',deep:true,minutes:5,deepPass}},'locate',{mode:'manual',minutes:10},0);
 assert.equal(status.mode,'explore');assert.equal(status.deep,true);assert.equal(status.minutes,5);assert.deepEqual(status.deepPass,deepPass);
});

test('Locate identifies a competing return-to-station task before starting its backend',async()=>{
 const service=new MapService({wakeForMapping:async()=>{},nativeMapping:async()=>({reports:{'/task/WorkState':{bytes:[5,255,1]}}})});
 service.navigation={call:async()=>assert.fail('must not start mapping')};
 await assert.rejects(service.graphScan({id:'map',scan:{}},'locate',{},0),/return-to-station is active/);
});

test('manual capture updates pose and map without navigation readiness or an automatic deadline',async()=>{
 const service=new MapService({stop:async()=>assert.fail('manual capture must not expire'),lidar:async()=>({result:{age_ms:10}})});
 service.schedule=()=>{};service.checkpoint=async()=>{};
 let frames=0;
 service.active={id:'map',lastStructure:Date.now(),lastGrid:0,lastSave:Date.now(),deadline:Date.now()-1000,scanner:{update:(grid,status)=>{frames++;assert.equal(grid.sequence,2);return {pose:status.pose,frames};}},status:{state:'scanning',mode:'manual'}};
 service.navigation={call:async action=>{
  if(action==='mapping/pause')assert.fail('manual capture must not be paused by timer');
  if(action==='grid')return {sequence:2,cells:[[1,2,127]]};
  return {active:false,ready:false,mapping:{map_id:'map',capture:true,boot_id:'boot',pose:{x:2,y:1,theta:.2}}};
 }};
 await service.graphTick();
 assert.equal(service.active.status.state,'scanning');assert.equal(service.active.status.pose.x,2);assert.equal(frames,1);
});


test('Locate waits for its transient wake task to become idle',async()=>{
 let reads=0;
 const service=new MapService({wakeForMapping:async()=>({woke:true}),nativeMapping:async action=>action==='status'?{boot_id:'boot',reports:{'/task/WorkState':{bytes:++reads===1?[9,255,1]:[7,255,0]}}}:{} });
 service.navigation={call:async()=>({location:{state:'locating',message:'Finding position'}})};
 service.checkpoint=async()=>{};service.schedule=()=>{};service.get=async()=>service.active.status;
 const status=await service.graphScan({id:'map',checkpoint:{},scan:{mode:'manual'}},'locate',{},0);
 assert.equal(reads,2);assert.equal(status.state,'locating');
});

test('Locate does not take over an existing remote-control task',async()=>{
 let reads=0;
 const service=new MapService({wakeForMapping:async()=>({woke:false}),nativeMapping:async()=>{reads++;return {reports:{'/task/WorkState':{bytes:[9,255,1]}}};}});
 service.navigation={call:async()=>assert.fail('must not start mapping')};
 await assert.rejects(service.graphScan({id:'map',scan:{}},'locate',{},0),/remote control is active/);
 assert.equal(reads,1);
});


test('station observation follows live tracking and ignores a switched map',async()=>{
 let resolve;const dock=new Promise(r=>{resolve=r;});
 const service=new MapService({dockStatus:()=>dock});
 const active={status:{state:'scanning',localization:'tracking',observedAt:Date.now(),pose:{x:1,y:2,theta:0}}};service.active=active;
 const pending=service.observeGraphStation(active);
 active.status.pose={x:3,y:4,theta:.2};
 resolve({docked:true,observedAt:Date.now()});await pending;
 assert.equal(active.station.x,3);
 let finish;service.engine.dockStatus=()=>new Promise(r=>{finish=r;});active.lastStationCheck=0;delete active.station;
 const obsolete=service.observeGraphStation(active);service.active={};
 finish({docked:true,observedAt:Date.now()});await obsolete;
 assert.equal(active.station,undefined);
});


test('manual departure wakes sensors without queuing a velocity',async()=>{
 let ready;let wakes=0;
 const service=new MapService({wakeForMapping:()=>{wakes++;return new Promise(r=>{ready=r;});}});
 service.active={status:{mode:'manual',state:'scanning',docked:true}};
 service.prepareManualDrive({linear:0,angular:0});assert.equal(wakes,0);
 assert.throws(()=>service.prepareManualDrive({linear:1,angular:0}),/Waking/);
 assert.throws(()=>service.prepareManualDrive({linear:1,angular:0}),/Waking/);assert.equal(wakes,1);
 ready();await service.active.manualWakeTask;
 service.prepareManualDrive({linear:1,angular:0});assert.equal(wakes,1);
});

test('docked Locate supplies only this map’s verified station as a search prior',async()=>{
 const station={x:2,y:3,theta:.2,source:'docked-robot-pose'};
 let request;
 const service=new MapService({dockStatus:async()=>({docked:true,observedAt:Date.now()}),wakeForMapping:async()=>{},nativeMapping:async()=>({boot_id:'new-boot',reports:{'/task/WorkState':{bytes:[7,255,0]}}})});
 service.save=async()=>{};service.checkpoint=async()=>{};service.schedule=()=>{};service.get=async()=>({});
 service.navigation={call:async(action,body)=>{request=body;return {location:{state:'locating',message:'Searching'}};}};
 await service.graphScan({id:'map',station,scan:{mode:'manual'},checkpoint:{}},'locate',{},0);
 assert.deepEqual(request.station_prior,station);
 assert.equal(service.active.status.localization,'locating');
 service.active=null;
 service.engine.dockStatus=async()=>({docked:false,observedAt:Date.now()});
 await service.graphScan({id:'map',station,scan:{mode:'manual'},checkpoint:{}},'locate',{},service.epoch);
 assert.equal(request.station_prior,undefined);
});

test('cockpit Stop cancels custom docking even in manual capture mode',async()=>{
 const service=new MapService({});let paused;
 service.active={id:'primary',status:{mode:'manual',state:'scanning',customReturn:{state:'observe'}}};
 service.scan=async(id,action)=>{paused={id,action};};
 assert.equal(service.exploring,true);
 await service.stopExploration();assert.deepEqual(paused,{id:'primary',action:'pause'});
});

test('custom return refuses to take over cleaning or an unverified station',async()=>{
 const service=new MapService({dockStatus:async()=>({docked:false}),nativeMapping:async()=>({reports:{'/task/WorkState':{bytes:[0,255,1]}}})});
 service.load=async()=>({station:{source:'docked-robot-pose'}});
 await assert.rejects(service.returnToStation('primary'),/firmware task/);
 service.load=async()=>({});await assert.rejects(service.returnToStation('primary'),/Locate the station/);
});

 test('Stop during engine health check cannot start a custom return afterward',async()=>{
 let resolveContact,calls=0;const service=new MapService({connect:()=>new Promise(resolve=>{resolveContact=resolve;})});
 const active={id:'primary',status:{state:'scanning'},returnStation:{}};service.active=active;
 service.navigation={call:async()=>{calls++;}};
 const pending=service.startCustomReturn(active);service.epoch++;active.status.state='paused';
 resolveContact({docked:false,observedAt:Date.now()});await pending;assert.equal(calls,0);
});

 test('cockpit release does not pause an already stopped mapping controller', async()=>{
  const service=new MapService({});
  service.navigation={call:async()=>{throw Error('unexpected navigation pause');}};
  service.scan=async()=>{throw Error('unexpected map pause');};
  await service.stopExploration();
  service.active={id:'primary',status:{mode:'manual',state:'paused',customReturn:{state:'failed'}}};
  await service.stopExploration();
 });

test('cockpit Stop cancels localization and pending return before scanning starts',async()=>{
 const service=new MapService({});let pauses=0;
 service.scan=async()=>{pauses++;};
 for(const status of [
  {mode:'manual',state:'locating',localization:'locating'},
  {mode:'manual',state:'locating',customReturn:{state:'preparing'}}
 ]){service.active={id:'primary',status};assert.equal(service.ownsMotion,true);await service.stopExploration();}
 assert.equal(pauses,2);
});

test('return prepares its own localization with bounded observation moves enabled',async()=>{
 const service=new MapService({dockStatus:async()=>({docked:false}),nativeMapping:async()=>({reports:{'/task/WorkState':{bytes:[7,255,0]}}})});
 service.load=async()=>({station:{source:'docked-robot-pose',x:1,y:2,theta:0}});
 service.pauseActive=async()=>{};service.get=async()=>service.active;
 let preparation;
 service.scan=async(id,action,options)=>{preparation={action,options};service.active={id,status:{state:'locating'}};};
 await service.returnToStation('primary');
 assert.deepEqual(preparation,{action:'resume',options:{mode:'manual',allowMotion:true}});
 assert.equal(service.active.returnPending,true);
});

test('return waits for navigation startup and proceeds without another user action',async()=>{
 let ready=false,docks=0;
 const service=new MapService({connect:async()=>{}});
 const a={id:'primary',status:{state:'scanning'},returnPending:true,returnStation:{x:0,y:0}};service.active=a;
 service.navigation={call:async action=>action==='status'?{ready,mapping:{pose:{x:2,y:0}}}:(docks++,{state:'navigate'})};
 await service.startCustomReturn(a);assert.equal(docks,0);assert.equal(a.returnPending,true);
 ready=true;await service.startCustomReturn(a);assert.equal(docks,1);assert.equal(a.returnPending,false);
});

test('onboard return installs saved map then hands off without companion heartbeat',async()=>{
 const calls=[];const service=new MapService({stop:async()=>{},onboardReturn:async(action='status',body)=>{calls.push(action);if(action==='config')assert.equal(body.map_id,'primary');return {active:false};}});
 service.navigation={call:async()=>{throw Error('companion offline');}};
 service.load=async()=>({station:{source:'docked-robot-pose',x:1,y:2,theta:0},checkpoint:{nativeGrid:{width:10,height:10,resolution:.05,origin:[0,0],cells:[[0,0,127]]}}});
 await service.returnOnboard('primary');assert.deepEqual(calls,['status','config','start','status']);assert.equal(service.active,null);
});
test('Stop while uploading onboard map cancels pending engine start',async()=>{
 let release,entered;const waiting=new Promise(r=>entered=r),upload=new Promise(r=>release=r),calls=[];
 const service=new MapService({stop:async()=>{},onboardReturn:async(action='status')=>{calls.push(action);if(action==='config'){entered();await upload;}return {active:false};}});
 service.navigation={call:async()=>{}};service.load=async()=>({station:{source:'docked-robot-pose',x:1,y:2,theta:0},checkpoint:{nativeGrid:{cells:[[0,0,127]]}}});
 const pending=service.returnOnboard('primary');await waiting;await service.stopExploration();release();await assert.rejects(pending,/cancelled/);assert(!calls.includes('start'));
});

test('ordinary localization checkpoint cannot relocate an established station',async()=>{
 const station={x:4.656772977429757,y:-1.7314394155166462,theta:1.6378575563211577,source:'docked-robot-pose'};
 const bad={x:6.554699780939094,y:-2.023441095102329,theta:2.476487323574037,source:'docked-robot-pose',method:'measured-departure'};
 const service=new MapService({});let saved;
 service.load=async()=>({station,displayAngle:0,scan:{}});service.save=async m=>{saved=m};
 const active={id:'primary',station:bad,status:{state:'paused'},scanner:{checkpoint:()=>({cells:[]})}};
 await service.checkpoint(active);assert.deepEqual(saved.station,station);assert.deepEqual(active.station,station);
 active.station=bad;active.stationRequested=true;
 await service.checkpoint(active);assert.deepEqual(saved.station,bad);
});
test('charging during ordinary Locate preserves the saved station',async()=>{
 const station={x:1,y:2,theta:0};
 const service=new MapService({dockStatus:async()=>({docked:true,observedAt:Date.now()})});service.navigation={call:async()=>{}};
 const active={station,status:{pose:{x:8,y:7,theta:2},localization:'located'}};
 await service.completeGraphLocation(active);assert.deepEqual(active.station,station);
 active.stationRequested=true;await service.completeGraphLocation(active);assert.equal(active.station.x,8);
});
