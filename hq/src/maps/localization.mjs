import { align, transform } from './scanner.mjs';
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
export function localPoints(scan) {
  return scan.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.hypot(p.x,p.y)>120 && Math.hypot(p.x,p.y)<12000).filter((_,i)=>i%2===0).map(p=>[p.x/1000,p.y/1000]);
}
// Coarse global search, followed by metric scan matching. Keep spatially
// distinct hypotheses: a repeated room must not silently become a position fix.
export function locate(scan, checkpoint) {
  const points=localPoints(scan);
  if(points.length<60) throw Error('Not enough LiDAR to locate Alfred.');
  const occupied=(checkpoint.cells||[]).filter(c=>c[2]>=2).map(c=>[(c[0]+.5)*.05,(c[1]+.5)*.05]);
  if(occupied.length<60) throw Error('Map has too little detail to locate Alfred.');
  const resolution=.15, field=new Map();
  for(const [x,y] of occupied) {
    const X=Math.floor(x/resolution),Y=Math.floor(y/resolution);
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) {
      const k=`${X+dx},${Y+dy}`,v=dx===0&&dy===0?1:.5;
      field.set(k,Math.max(v,field.get(k)||0));
    }
  }
  const positions=new Map();
  const add=(x,y)=>positions.set(`${Math.round(x/.3)},${Math.round(y/.3)}`,[x,y]);
  for(const f of checkpoint.keyframes||[]) {
    add(f.pose.x,f.pose.y);
    for(let x=-.3;x<=.3;x+=.3)for(let y=-.3;y<=.3;y+=.3)add(f.pose.x+x,f.pose.y+y);
  }
  if(checkpoint.pose)add(checkpoint.pose.x,checkpoint.pose.y);
  for(const [x,y,v] of checkpoint.cells||[]) if(v<0 && x%6===0 && y%6===0)add((x+.5)*.05,(y+.5)*.05);
  if(positions.size>15000)throw Error('Map is too large for this position search. Choose a smaller reference map.');
  const count=Math.min(91,points.length), sparse=Array.from({length:count},(_,i)=>points[Math.floor(i*points.length/count)]);
  let candidates=[];
  for(let a=0;a<72;a++) {
    const theta=a*Math.PI/36,c=Math.cos(theta),s=Math.sin(theta),rotated=sparse.map(([x,y])=>[c*x-s*y,s*x+c*y]);
    for(const [x,y] of positions.values()) {
      let score=0;
      for(const [px,py] of rotated)score+=field.get(`${Math.floor((px+x)/resolution)},${Math.floor((py+y)/resolution)}`)||0;
      score/=rotated.length;
      if(score>.48)candidates.push({x,y,theta,score});
    }
    if(candidates.length>3000)candidates.sort((a,b)=>b.score-a.score).splice(1000);
  }
  candidates.sort((a,b)=>b.score-a.score);
  const hypotheses=[];
  for(const p of candidates) {
    if(hypotheses.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<.3&&Math.abs(wrap(p.theta-q.theta))<.2))continue;
    hypotheses.push(p);if(hypotheses.length>=24)break;
  }
  const matches=hypotheses.map(p=>align(points,occupied,p)).filter(m=>m.ok&&m.coverage>.8&&m.rms<.055).sort((a,b)=>(b.coverage-b.rms*4)-(a.coverage-a.rms*4));
  const best=matches[0];
  if(!best)throw Error('Position not recognized in this map. Keep Alfred still in a mapped area and try Locate again.');
  const competing=matches.find(m=>Math.hypot(m.pose.x-best.pose.x,m.pose.y-best.pose.y)>.5||Math.abs(wrap(m.pose.theta-best.pose.theta))>.35);
  if(competing && best.coverage-best.rms*4-(competing.coverage-competing.rms*4)<.08)throw Error('Position is ambiguous. Move Alfred where more distinctive mapped features are visible, then locate again.');
  return {pose:{...best.pose,theta:wrap(best.pose.theta)},rms:best.rms,coverage:best.coverage};
}

export function relative(a,b) {
  const c=Math.cos(a.theta),s=Math.sin(a.theta),x=b.x-a.x,y=b.y-a.y;
  return {x:c*x+s*y,y:-s*x+c*y,theta:wrap(b.theta-a.theta)};
}
export function compose(a,b) {
  return {x:a.x+Math.cos(a.theta)*b.x-Math.sin(a.theta)*b.y,y:a.y+Math.sin(a.theta)*b.x+Math.cos(a.theta)*b.y,theta:wrap(a.theta+b.theta)};
}
export function inverse(p) { return relative(p,{x:0,y:0,theta:0}); }
// Weighted SE(2) graph relaxation. The first pose fixes the map frame;
// odometry and revisit edges distribute corrections over the whole trajectory.
export function optimizeGraph(frames, edges) {
  const poses=frames.map(f=>({...f.pose}));
  for(let iteration=0;iteration<160;iteration++) {
    const targets=poses.map(()=>[]);
    for(const e of edges) {
      const weight=e.loop?8:1;
      targets[e.b].push([compose(poses[e.a],e.delta),weight]);
      targets[e.a].push([compose(poses[e.b],inverse(e.delta)),weight]);
    }
    let change=0;
    for(let i=1;i<poses.length;i++) {
      const p=poses[i];let x=0,y=0,t=0,w=0;
      for(const [q,k] of targets[i]) {x+=(q.x-p.x)*k;y+=(q.y-p.y)*k;t+=wrap(q.theta-p.theta)*k;w+=k;}
      if(!w)continue;
      const rate=.45/w;change+=Math.hypot(x,y)*rate+Math.abs(t)*rate;
      poses[i]={x:p.x+x*rate,y:p.y+y*rate,theta:wrap(p.theta+t*rate)};
    }
    if(change<1e-6)break;
  }
  return poses;
}
