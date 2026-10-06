import test from 'node:test';
import assert from 'node:assert/strict';
import {MapService} from '../src/maps/map-service.mjs';
function service(){
 const calls=[];const s=Object.create(MapService.prototype);s.epoch=0;
 s.load=async()=>({revision:2,checkpoint:{nativeGrid:{resolution:.05,width:10,height:10,origin:[0,0],cells:[[1,1,127]]}}});
 s.pauseActive=async()=>{calls.push('pause');s.epoch++;};
 s.engine={ensureMappingLidar:async()=>{calls.push('lidar-ready');},localization:async(a,b)=>calls.push(['map',b]),navigate:async(a,b)=>{calls.push([a,b]);return {active:true};}};
 return {s,calls};
}
test('point navigation installs a saved map and hands ownership to native engine without station requirement',async()=>{
 const {s,calls}=service();const pose={x:1,y:2,theta:0};
 assert.equal((await s.navigateTo('map',pose)).active,true);
 assert.equal(calls[0],'pause');assert.equal(calls[1],'lidar-ready');assert.equal(calls[2][1].map_id,'map');assert.deepEqual(calls[3],['start',{map_id:'map',pose}]);
});
test('cancel during navigation preparation prevents delayed motor start',async()=>{
 const {s,calls}=service();s.engine.localization=async()=>{s.epoch++;};
 await assert.rejects(s.navigateTo('map',{x:1,y:2,theta:0}),/cancelled/);
 assert.equal(calls.some(c=>Array.isArray(c)&&c[0]==='start'),false);
});
test('invalid destination is rejected before stopping existing work',async()=>{
 const {s,calls}=service();await assert.rejects(s.navigateTo('map',{x:NaN,y:2,theta:0}),/finite/);assert.equal(calls.length,0);
});

test('stop during lidar wake prevents navigation start',async()=>{
 const {s,calls}=service();s.engine.ensureMappingLidar=async()=>{s.epoch++;};
 await assert.rejects(s.navigateTo('map',{x:1,y:2,theta:0}),/cancelled/);
 assert.deepEqual(calls,['pause']);
});
test('failed lidar wake prevents navigation start',async()=>{
 const {s,calls}=service();s.engine.ensureMappingLidar=async()=>{throw Error('LiDAR failed');};
 await assert.rejects(s.navigateTo('map',{x:1,y:2,theta:0}),/LiDAR failed/);
 assert.deepEqual(calls,['pause']);
});

test('cat mode wakes lidar, installs the map, then hands search to engine',async()=>{
 const {s,calls}=service();s.engine.onboardReturn=async()=>({active:false});s.engine.catFollow=async(a,b)=>{calls.push(['cat',a,b]);return {active:true};};
 assert.equal((await s.followCat('map')).active,true);
 assert.deepEqual(calls.slice(0,2),['pause','lidar-ready']);
 assert.equal(calls[2][1].map_id,'map');assert.deepEqual(calls[3],['cat','start',{map_id:'map'}]);
});
test('cat mode cannot start after cancellation during wake',async()=>{
 const {s,calls}=service();s.engine.onboardReturn=async()=>({active:false});s.engine.ensureMappingLidar=async()=>{s.epoch++;};s.engine.catFollow=async()=>assert.fail('must not start');
 await assert.rejects(s.followCat('map'),/cancelled/);
});
test('cat mode refuses to replace an existing engine operation',async()=>{
 const {s,calls}=service();s.engine.onboardReturn=async()=>({active:true});
 await assert.rejects(s.followCat('map'),/Stop the active/);assert.deepEqual(calls,[]);
});
