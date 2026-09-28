import {test} from 'node:test';
import assert from 'node:assert/strict';
import {floorGeometry} from '../src/maps/floor.mjs';
const rectangle=(x,y,w,h)=>Array.from({length:w*h},(_,i)=>[x+i%w,y+Math.floor(i/w),-8]);
test('floor makes closed connected rings, retaining open scan edges',()=>{
 const cells=rectangle(0,0,80,60);
 for(let x=0;x<80;x++)cells.push([x,-1,8]);
 const floor=floorGeometry(cells,0,[[[0,-.025],[4,-.025]]]);
 assert.equal(floor.geometry.length,1);
 assert.deepEqual(floor.geometry[0][0][0],floor.geometry[0][0].at(-1));
 assert.ok(floor.area>11&&floor.area<=12.1);
 assert.ok(floor.boundary.some(e=>e.kind==='wall'));
 assert.ok(floor.boundary.some(e=>e.kind==='unobserved'));
});
test('floor keeps separate unobserved gaps separate',()=>{
 const floor=floorGeometry([...rectangle(0,0,20,20),...rectangle(50,0,20,20)],0);
 assert.equal(floor.geometry.length,2);
 assert.ok(floor.area<2.1);
});

test('occupied edges without structural evidence are obstacles, not walls',()=>{
 const cells=rectangle(0,0,60,40);
 for(let x=0;x<60;x++)cells.push([x,-1,8]);
 const floor=floorGeometry(cells,0);
 assert.ok(floor.boundary.some(e=>e.kind==='obstacle'));
 assert.ok(!floor.boundary.some(e=>e.kind==='wall'));
});

test('floor hides unvisited disconnected returns but keeps a previously visited room',()=>{
 const cells=[...rectangle(0,0,20,20),...rectangle(50,0,20,20)];
 assert.equal(floorGeometry(cells,0,[],[{x:.5,y:.5}]).geometry.length,1);
 assert.equal(floorGeometry(cells,0,[],[{x:.5,y:.5},{x:3.,y:.5}]).geometry.length,2);
});
