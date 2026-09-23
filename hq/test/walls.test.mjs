import {test} from 'node:test';
import assert from 'node:assert/strict';
import {structuralPlan,supportedWalls} from '../src/maps/walls.mjs';
const wall=(from,to,y=0)=>Array.from({length:to-from+1},(_,i)=>[from+i,y,8]);
test('structural plan preserves doorway gaps and rejects free-space contradictions',()=>{
 const cells=[...wall(0,30),...wall(50,80)];
 let plan=structuralPlan(cells,{},1);
 plan=structuralPlan(cells,plan,2);
 assert.equal(plan.walls.filter(w=>w.observations>=2).length,2);
 for(const {points:[a,b]} of plan.walls)assert.ok(Math.abs(b[0]-a[0])<1.6);
 const ids=plan.walls.map(w=>w.id);
 assert.deepEqual(structuralPlan(cells,plan,3).walls.map(w=>w.id),ids);
 assert.equal(structuralPlan(cells.map(([x,y])=>[x,y,-8]),plan,4).walls.length,0);
 assert.equal(structuralPlan(cells,plan,2),plan,'same grid is not independent evidence');
});
test('partially overlapping observations can jointly support a wall',()=>{
 const cells=wall(0,60),points=cells.map(([x,y])=>[(x+.5)*.05,(y+.5)*.05]);
 const frames=[{pose:{x:0,y:1},points:points.slice(0,40)},{pose:{x:1,y:1},points:points.slice(10,51)},{pose:{x:2,y:1},points:points.slice(21)}];
 assert.equal(supportedWalls(cells,frames).length,1);
});

test('a corrected snapshot replaces accumulated historical wall fragments',()=>{
 const cells=wall(0,80);
 const old=Array.from({length:10},(_,i)=>({id:`old-${i}`,observations:20,points:[[.025+i*.01,.025],[3.8+i*.01,.025]]}));
 const plan=structuralPlan(cells,{version:1,sequence:'same',axis:0,walls:old},'same');
 assert.equal(plan.version,3);
 assert.equal(plan.walls.length,1);
});

test('consolidation merges repeated edges but keeps a measured doorway open',async()=>{
 const {consolidateWalls}=await import('../src/maps/walls.mjs');
 const cells=[...wall(0,40),...wall(55,90)];
 const segments=[[[.025,.025],[1.4,.025]],[[.8,.03],[2.025,.03]],[[2.775,.025],[4.525,.025]]];
 const lines=consolidateWalls(segments,cells,0);
 assert.equal(lines.length,2);
 assert.ok(lines.every(([a,b])=>!(Math.min(a[0],b[0])<2.2&&Math.max(a[0],b[0])>2.6)));
});

test('continuous wall fitting retains perpendicular walls among scattered clutter',async()=>{
 const {wallSegments}=await import('../src/maps/walls.mjs');
 const cells=[...wall(0,80,0),...Array.from({length:50},(_,y)=>[0,y,8])];
 for(let y=6;y<48;y+=6)for(let x=20;x<160;x+=23)cells.push([x,y,8],[x+1,y,8]);
 const lines=wallSegments(cells);
 assert.ok(lines.some(([a,b])=>Math.abs(b[1]-a[1])>2 && Math.abs(b[0]-a[0])<.1),'retain the continuous vertical wall');
 assert.ok(lines.some(([a,b])=>Math.abs(b[0]-a[0])>3 && Math.abs(b[1]-a[1])<.1),'retain the continuous horizontal wall');
});
