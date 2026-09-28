import test from 'node:test';
import assert from 'node:assert/strict';
import {MapService} from '../src/maps/map-service.mjs';
test('ordinary Locate uses only engine and leaves station and scan options intact',async()=>{
 const calls=[];const engine={wakeForMapping:async()=>{},localization:async(action,body)=>{calls.push([action,body]);return {map_id:'primary',state:'located',pose:{x:1,y:2,theta:0},message:'tracked'};}};
 const service=new MapService(engine);service.schedule=()=>{};service.navigation.call=async()=>{throw Error('mapping backend must not be required');};
 const m={id:'primary',revision:5,scan:{mode:'manual',deep:true},station:{x:4,y:5,theta:1},checkpoint:{backend:'slam_toolbox',nativeGrid:{cells:[[1,1,129]]},cells:[],frames:0}};
 service.get=async()=>service.active.status;service.load=async()=>m;service.save=async()=>{};
 await service.graphScan(m,'locate',{},0);
 assert.deepEqual(calls.map(c=>c[0]),['map','locate']);assert.equal(service.active.status.deep,true);
 await service.graphScan(m,'locate',{},1);assert.equal(calls.length,2);
 await service.engineLocateTick();assert.equal(service.active.status.localization,'located');assert.deepEqual(m.station,{x:4,y:5,theta:1});
});
