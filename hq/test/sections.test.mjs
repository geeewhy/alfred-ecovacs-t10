import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MapService} from '../src/maps/map-service.mjs';
import {ChatService} from '../src/bot/chat-service.mjs';
import {polygon} from '../src/maps/geometry.mjs';
import {sectionTarget,containsPoint} from '../src/maps/sections.mjs';
import {selectionCorners,sectionAnchor} from '../public/map-sections.js';
const square=[[0,0],[4,0],[4,4],[0,4]];
async function fixture(fn){const dir=await mkdtemp(path.join(tmpdir(),'sections-'));try{const service=new MapService({},dir);const map=await service.create({name:'Primary'});map.structure={floor:{geometry:polygon(square)},walls:[]};map.station={x:2,y:2};await service.save(map);await fn(service,map,dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('sections clip to floor, preserve robot data, persist aliases and stable identity across rename/reload',()=>fixture(async(s,m,dir)=>{
 let map=await s.edit(m.id,{revision:0,action:'save-section',name:'Living room',aliases:['Lounge','the lounge'],points:[[-1,-1],[2,-1],[2,2],[-1,2]]});
 assert.equal(map.areas[0].area,4);assert.deepEqual(map.areas[0].aliases,['Lounge']);assert.deepEqual(map.station,m.station);
 const id=map.areas[0].id;const reloaded=new MapService({},dir);
 assert.equal((await reloaded.resolveSection('THE LOUNGE')).section.id,id);
 map=await reloaded.edit(m.id,{revision:1,action:'save-section',id,name:'Sitting room',aliases:['Living room']});
 assert.equal(map.areas[0].id,id);assert.equal((await reloaded.resolveSection('Lounge')).status,'not-found');
 assert.equal((await reloaded.resolveSection('living room')).section.name,'Sitting room');
 await reloaded.edit(m.id,{revision:2,action:'delete',ids:[id]});assert.equal((await reloaded.resolveSection('Living room')).status,'not-found');
 await reloaded.edit(m.id,{revision:3,action:'undo'});assert.equal((await reloaded.resolveSection('Living room')).section.id,id);
}));
test('rejects duplicate aliases, invalid selections, stale edits and missing sections without mutation',()=>fixture(async(s,m)=>{
 await s.edit(m.id,{revision:0,action:'save-section',name:'Kitchen',points:square});
 for(const body of [{name:'Other',aliases:['the kitchen'],points:square},{name:'',points:square},{name:'!?!',points:square},{name:'Other',points:[[10,10],[11,10],[11,11],[10,11]]},{id:'missing',name:'Other'}])await assert.rejects(s.edit(m.id,{revision:1,action:'save-section',...body}));
 await assert.rejects(s.edit(m.id,{revision:0,action:'save-section',name:'Other',points:square}),/Map changed/);
 assert.equal((await s.load(m.id)).revision,1);
}));
test('same place name across maps is ambiguous until a map is specified',()=>fixture(async(s,m)=>{
 await s.edit(m.id,{revision:0,action:'save-section',name:'Kitchen',points:square});
 const other=await s.create({name:'Upstairs'});other.structure=m.structure;await s.save(other);
 await s.edit(other.id,{revision:0,action:'save-section',name:'Kitchen',points:square});
 assert.equal((await s.resolveSection('Kitchen')).status,'ambiguous');
 assert.equal((await s.resolveSection('Kitchen',m.id)).section.mapId,m.id);
}));
test('section destination avoids holes, occupied and unknown footprint cells; missing grid has no destination',()=>{
 const section={geometry:polygon(square)};const cells=[];for(let y=0;y<40;y++)for(let x=0;x<40;x++)cells.push([x,y,(x>=17&&x<=23&&y>=17&&y<=23)?129:127]);
 const map={checkpoint:{nativeGrid:{width:40,height:40,resolution:.1,origin:[0,0],cells}}};
 const target=sectionTarget(map,section);assert.ok(target);assert.ok(containsPoint(section.geometry,[target.x,target.y]));assert.ok(Math.hypot(target.x-2,target.y-2)>.5);
 assert.equal(sectionTarget({},section),null);
 assert.equal(sectionTarget({checkpoint:{nativeGrid:{width:40,height:40,resolution:.1,origin:[0,0],cells:[[20,20,127]]}}},section),null);
 const hole=polygon([[1,1],[3,1],[3,3],[1,3]])[0][0];assert.equal(containsPoint([[section.geometry[0][0],hole]],[2,2]),false);
});
test('selection rectangle remains aligned with display when the plan is rotated',()=>{
 const angle=Math.PI/3,points=selectionCorners([1,2],[3,5],angle),c=Math.cos(angle),s=Math.sin(angle),q=points.map(([x,y])=>[x*c+y*s,-x*s+y*c]);
 assert.ok(Math.abs(q[0][1]-q[1][1])<1e-9);assert.ok(Math.abs(q[1][0]-q[2][0])<1e-9);assert.deepEqual(points[0],[1,2]);
});
test('each chat request includes fresh section aliases and ambiguity policy without issuing motion',()=>fixture(async(s,m,dir)=>{
 await s.edit(m.id,{revision:0,action:'save-section',name:'Living room',aliases:['Lounge'],points:square});
 const transcript=path.join(dir,'transcript');await writeFile(transcript,'');const calls=[];
 const chat=new ChatService({}, {poll:false,file:path.join(dir,'chat','state.json'),sections:()=>s.sectionCatalog(),command:async args=>{calls.push(args);return {};}});
 await chat.ready;chat.state.enabled=true;chat.session=async()=>({id:'fake',transcript_path:transcript});
 await chat.send('Where is the lounge?');const prompt=calls[0][3];assert.match(prompt,/Living room/);assert.match(prompt,/Lounge/);assert.match(prompt,/never guess/);assert.match(prompt,/not movement authorization/);assert.equal(calls.length,1);
 const map=await s.load(m.id);await s.edit(m.id,{revision:1,action:'save-section',id:map.areas[0].id,name:'Office',aliases:[]});
 chat.state.pending=null;await chat.send('What sections do you know?');assert.match(calls[1][3],/Office/);assert.doesNotMatch(calls[1][3],/Living room/);
}));

test('section labels stay inside concave floor and outside holes',()=>{
 const shape=polygon([[0,0],[4,0],[4,1],[1,1],[1,4],[0,4]]);
 assert.ok(containsPoint(shape,sectionAnchor(shape)));
 const ring=polygon(square)[0][0],hole=polygon([[1,1],[3,1],[3,3],[1,3]])[0][0],g=[[ring,hole]];
 assert.ok(containsPoint(g,sectionAnchor(g)));
});
