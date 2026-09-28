import test from 'node:test';
import assert from 'node:assert/strict';
import {stationObservation} from '../src/maps/station.mjs';
test('charging contact alone cannot place a station using an unverified saved pose',()=>{
 assert.throws(()=>stationObservation({docked:true,observedAt:1000},{x:1,y:2,theta:0},'locating',1000),/Verify/);
 assert.throws(()=>stationObservation({docked:true,observedAt:1000},{x:1,y:2,theta:0},'located',7000),/Fresh/);
 assert.throws(()=>stationObservation({docked:false,observedAt:1000},{x:1,y:2,theta:0},'located',1000),/Fresh/);
});
test('the same detection supports independent verified poses in any map',()=>{
 const dock={docked:true,observedAt:1000};
 assert.equal(stationObservation(dock,{x:1,y:2,theta:0},'located',1000).x,1);
 assert.equal(stationObservation(dock,{x:9,y:8,theta:1},'located',1000).x,9);
});

test('continuous verified tracking can register charging contact in its own map',()=>{
 assert.equal(stationObservation({docked:true,observedAt:1000},{x:2,y:3,theta:0},'tracking',1000).y,3);
});
