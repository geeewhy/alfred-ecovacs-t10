import test from 'node:test';
import assert from 'node:assert/strict';
import {livePosition} from '../src/maps/live-position.mjs';
const pose={x:1,y:2,theta:.4,age_ms:40};
const nav={mapping:{map_id:'primary',pose},telemetry:{wheel_age_ms:20}};
test('live map pose stays available outside a scan; never uses native odometry',()=>{
 assert.deepEqual(livePosition('primary',null,nav).pose,pose);
 assert.equal(livePosition('other',null,nav).pose,null);
 assert.equal(livePosition('primary',null,{pose}).pose,null);
});
test('stale telemetry, lost matching and nonfinite poses are not live',()=>{
 assert.equal(livePosition('primary',null,{...nav,telemetry:{wheel_age_ms:1500}}).pose,null);
 for (const mapping of [{...nav.mapping,tracking_error:'Lost'},{...nav.mapping,pose:{...pose,age_ms:900}},{...nav.mapping,pose:{...pose,x:NaN}}]) assert.equal(livePosition('primary',null,{...nav,mapping}).pose,null);
});
test('active onboard map pose takes precedence; inactive return pose cannot freeze marker',()=>{
 const onboard={active:true,map_id:'primary',pose:{...pose,x:3},state:'rear-alignment'};
 assert.equal(livePosition('primary',onboard,nav).pose.x,3);
 assert.equal(livePosition('primary',{...onboard,active:false},nav).pose.x,1);
 assert.equal(livePosition('primary',{...onboard,state:'locating'},nav).pose,null);
});
test('engine position works without navigation; stale or wrong map never falls back',()=>{
 const engine={map_id:'primary',state:'located',pose,age_ms:20};
 assert.equal(livePosition('primary',null,null,engine).pose.x,1);
 for(const value of [null,{...engine,map_id:'other'},{...engine,age_ms:1800},{...engine,state:'locating'}])assert.equal(livePosition('primary',null,nav,value).pose,null);
});
