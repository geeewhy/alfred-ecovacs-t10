import {floorGeometry} from './floor.mjs';
// Fit structural line segments to occupied observations. Gaps remain openings;
// short clutter is omitted from the floor-plan layer, not erased from the map.
export function wallSegments(cells, axis = null) {
  let points=cells.filter(c=>c[2]>=2).map(([x,y])=>[(x+.5)*.05,(y+.5)*.05]);
  if(points.length>5000)points=points.filter((_,i)=>i%Math.ceil(points.length/5000)===0);
  const segments=[];let seed=7183;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let pass=0;pass<80 && points.length>=8;pass++) {
    let best=[];
    for(let attempt=0;attempt<100;attempt++) {
      const a=points[random(points.length)],b=points[random(points.length)],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
      if(length<.4 || length>5)continue;
      const inliers=[];
      for(let i=0;i<points.length;i++)if(Math.abs(dx*(points[i][1]-a[1])-dy*(points[i][0]-a[0]))/length<.055)inliers.push(i);
      // Score one continuous surface, not the sum of unrelated collinear
      // returns across several rooms. The old score consumed vertical walls
      // a few cells at a time while fitting long diagonal/horizontal scribbles.
      if(inliers.length<=best.length)continue;
      const projected=inliers.map(i=>[i,(points[i][0]-a[0])*dx/length+(points[i][1]-a[1])*dy/length]).sort((a,b)=>a[1]-b[1]);
      let start=0;
      for(let end=1;end<=projected.length;end++)if(end===projected.length || projected[end][1]-projected[end-1][1]>.18){
        if(end-start>best.length)best=projected.slice(start,end).map(p=>p[0]);
        start=end;
      }
    }
    if(best.length<8)break;
    const cloud=best.map(i=>points[i]),center=cloud.reduce((a,p)=>[a[0]+p[0]/cloud.length,a[1]+p[1]/cloud.length],[0,0]);
    let xx=0,xy=0,yy=0;
    for(const p of cloud){const x=p[0]-center[0],y=p[1]-center[1];xx+=x*x;xy+=x*y;yy+=y*y;}
    const theta=.5*Math.atan2(2*xy,xx-yy),c=Math.cos(theta),s=Math.sin(theta);
    const projected=cloud.map(p=>(p[0]-center[0])*c+(p[1]-center[1])*s).sort((a,b)=>a-b);
    let group=[];
    const add=()=>{if(group.length>=8 && group.at(-1)-group[0]>=.4)segments.push([group[0],group.at(-1)].map(t=>[center[0]+t*c,center[1]+t*s]));};
    for(const t of projected){if(group.length && t-group.at(-1)>.25){add();group=[];}group.push(t);}add();
    const removed=new Set(best);points=points.filter((_,i)=>!removed.has(i));
  }
  // Snap only near-perpendicular wall families to a measured dominant axis.
  const bins=new Array(90).fill(0);
  for(const [a,b] of segments){let angle=Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI;angle=((angle%90)+90)%90;bins[Math.round(angle)%90]+=Math.hypot(b[0]-a[0],b[1]-a[1]);}
  const peak=bins.indexOf(Math.max(...bins))*Math.PI/180;
  let sx=0,sy=0;
  for(const [a,b] of segments){const t=Math.atan2(b[1]-a[1],b[0]-a[0]),d=Math.atan2(Math.sin(4*(t-peak)),Math.cos(4*(t-peak)))/4;if(Math.abs(d)<Math.PI/18){const w=Math.hypot(b[0]-a[0],b[1]-a[1]);sx+=w*Math.cos(4*t);sy+=w*Math.sin(4*t);}}
  const dominant=axis??Math.atan2(sy,sx)/4;
  for(const segment of segments){const [a,b]=segment,theta=Math.atan2(b[1]-a[1],b[0]-a[0]),target=dominant+Math.round((theta-dominant)/(Math.PI/2))*Math.PI/2;
    if(Math.abs(theta-target)>Math.min(Math.PI/36,Math.atan2(.08,Math.hypot(b[0]-a[0],b[1]-a[1])/2)))continue;
    const x=(a[0]+b[0])/2,y=(a[1]+b[1])/2,r=Math.hypot(b[0]-a[0],b[1]-a[1])/2;
    segment[0]=[x-r*Math.cos(target),y-r*Math.sin(target)];segment[1]=[x+r*Math.cos(target),y+r*Math.sin(target)];
  }
  // Join supported nearby corners, never bridge a doorway or extrapolate far.
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
    const [a,b]=segments[i],[c,d]=segments[j],u=[b[0]-a[0],b[1]-a[1]],v=[d[0]-c[0],d[1]-c[1]],det=u[0]*v[1]-u[1]*v[0];
    if(Math.abs(det)<.2*Math.hypot(...u)*Math.hypot(...v))continue;
    const t=((c[0]-a[0])*v[1]-(c[1]-a[1])*v[0])/det,p=[a[0]+t*u[0],a[1]+t*u[1]];
    const ia=Math.hypot(a[0]-p[0],a[1]-p[1])<Math.hypot(b[0]-p[0],b[1]-p[1])?0:1,ib=Math.hypot(c[0]-p[0],c[1]-p[1])<Math.hypot(d[0]-p[0],d[1]-p[1])?0:1;
    if(Math.hypot(segments[i][ia][0]-p[0],segments[i][ia][1]-p[1])<.15 && Math.hypot(segments[j][ib][0]-p[0],segments[j][ib][1]-p[1])<.15){segments[i][ia]=[...p];segments[j][ib]=[...p];}
  }
  return segments;
}

// A line fit is only a candidate. Require repeat observation from separated
// robot positions before exposing it as a structural wall or routing constraint.
// Select independent viewpoints per wall bin, not globally: a nearby later scan
// can reveal a surface that an earlier scan at the same location could not see.
export function supportedWalls(cells, keyframes = [], axis = null) {
  const evidence=keyframes.filter(f=>f.pose && Array.isArray(f.points));
  if(evidence.length<2)return [];
  const grid=new Map(cells.map(([x,y,v])=>[`${x},${y}`,v]));
  return wallSegments(cells,axis).filter(([a,b])=>{
    const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    if(length<.6)return false;
    const dx=(b[0]-a[0])/length,dy=(b[1]-a[1])/length,bins=Math.ceil(length/.15);
    let free=0;
    for(let i=0;i<bins;i++){const t=(i+.5)*length/bins,x=a[0]+dx*t,y=a[1]+dy*t;if((grid.get(`${Math.floor(x/.05)},${Math.floor(y/.05)}`)||0)<=-4)free++;}
    if(free/bins>.2)return false;
    // Combine partial views along the wall; a doorway or occlusion need not
    // leave any one viewpoint with visibility of the entire segment.
    const votes=new Uint8Array(bins);
    const firstView=new Array(bins);
    for(const frame of evidence){
      const hits=new Set();
      for(const p of frame.points){const x=p[0]-a[0],y=p[1]-a[1],t=x*dx+y*dy;if(t>=0&&t<=length&&Math.abs(x*dy-y*dx)<.075)hits.add(Math.min(bins-1,Math.floor(t/length*bins)));}
      for(const bin of hits) {
        if(!firstView[bin]) { firstView[bin]=frame.pose; votes[bin]=1; }
        else if(Math.hypot(firstView[bin].x-frame.pose.x,firstView[bin].y-frame.pose.y)>=.10) votes[bin]=2;
      }
    }
    return [...votes].filter(n=>n>=2).length/bins>=.7;
  });
}

// Graph SLAM has already fused observations in the corrected map frame. Build
// structure from that grid, never from historical uncorrected HQ scan poses.
// Keep identities across grid revisions, but remove geometry contradicted by
// the current grid (including after a loop-closure correction).
export function structuralPlan(cells, previous = {}, sequence = null, keyframes = null) {
  if(previous.version===3 && sequence != null && previous.sequence === sequence)return previous;
  const grid=new Map(cells.map(([x,y,v])=>[`${x},${y}`,v]));
  const coverage=([a,b])=>{
    const length=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.max(1,Math.ceil(length/.05));
    let hits=0,free=0;
    for(let i=0;i<n;i++){
      const t=(i+.5)/n,x=Math.floor((a[0]+t*(b[0]-a[0]))/.05),y=Math.floor((a[1]+t*(b[1]-a[1]))/.05);
      let occupied=false;
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if((grid.get(`${x+dx},${y+dy}`)||0)>=2)occupied=true;
      if(occupied)hits++;else if((grid.get(`${x},${y}`)||0)<=-4)free++;
    }
    return {hit:hits/n,free:free/n};
  };
  const remaining=[...(previous.walls||[])],walls=[];
  const candidates=keyframes ? supportedWalls(cells,keyframes,previous.axis) : wallSegments(cells,previous.axis);
  for(const points of consolidateWalls(candidates,cells,previous.axis)){
    const [a,b]=points,length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    if(length<.6 || coverage(points).hit<.75)continue;
    const match=remaining.findIndex(w=>{
      const [c,d]=w.points;
      return Math.min(Math.hypot(a[0]-c[0],a[1]-c[1])+Math.hypot(b[0]-d[0],b[1]-d[1]),Math.hypot(a[0]-d[0],a[1]-d[1])+Math.hypot(b[0]-c[0],b[1]-c[1]))<.4;
    });
    const prior=match<0?null:remaining.splice(match,1)[0];
    walls.push({id:prior?.id||`wall-${points.flat().map(n=>Math.round(n*20)).join('-')}`,points,observations:(prior?.observations||(keyframes?1:0))+1});
  }
  // Identity is historical; geometry is not. Retaining unmatched old fits made
  // every SLAM correction add another overlapping wall to the finished plan.
  let axis=previous.axis;
  const accepted=walls.filter(w=>w.observations>=2);
  if(axis==null && accepted.length>=3){
    const v=accepted.reduce((v,{points:[a,b]})=>{const w=Math.hypot(b[0]-a[0],b[1]-a[1]),t=4*Math.atan2(b[1]-a[1],b[0]-a[0]);return [v[0]+w*Math.cos(t),v[1]+w*Math.sin(t),v[2]+w];},[0,0,0]);
    if(v[2]>3 && Math.hypot(v[0],v[1])/v[2]>.85)axis=Math.atan2(v[1],v[0])/4;
  }
  return {version:3,sequence,axis,walls,floor:floorGeometry(cells,axis,walls.filter(w=>w.observations>=2).map(w=>w.points),keyframes?.map(f=>f.pose))};
}

// Consolidate the current measured edges before assigning persistent identities.
// This presentation geometry never replaces SLAM occupancy for navigation.
export function consolidateWalls(segments,cells,axis=null) {
  const grid=new Map(cells.map(([x,y,v])=>[`${x},${y}`,v]));
  const at=p=>grid.get(`${Math.floor(p[0]/.05)},${Math.floor(p[1]/.05)}`)||0;
  const occupied=p=>{
    const x=Math.floor(p[0]/.05),y=Math.floor(p[1]/.05);
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if((grid.get(`${x+dx},${y+dy}`)||0)>=2)return true;
    return false;
  };
  const supported=([a,b])=>{
    const n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.05));let hits=0,free=0;
    for(let i=0;i<=n;i++){const p=a.map((v,k)=>v+(b[k]-v)*i/n);if(occupied(p))hits++;else if(at(p)<=-4)free++;}
    return hits/(n+1)>=.8 && free/(n+1)<.1;
  };
  if(axis==null){
    const bins=Array(90).fill(0);
    for(const [a,b] of segments){const t=Math.atan2(b[1]-a[1],b[0]-a[0]),l=Math.hypot(b[0]-a[0],b[1]-a[1]);bins[((Math.round(t*180/Math.PI)%90)+90)%90]+=l;}
    let best=0,score=-1;
    for(let i=0;i<90;i++){let sum=0;for(let d=-5;d<=5;d++)sum+=bins[(i+d+90)%90];if(sum>score){score=sum;best=i;}}
    axis=best*Math.PI/180;
  }
  let lines=segments.map(points=>{
    const [a,b]=points,l=Math.hypot(b[0]-a[0],b[1]-a[1]),t=Math.atan2(b[1]-a[1],b[0]-a[0]);
    const target=axis+Math.round((t-axis)/(Math.PI/2))*Math.PI/2;
    const center=a.map((v,k)=>(v+b[k])/2),u=[Math.cos(target),Math.sin(target)];
    const snapped=[center.map((v,k)=>v-u[k]*l/2),center.map((v,k)=>v+u[k]*l/2)];
    return Math.abs(t-target)<Math.PI/22.5 && supported(snapped)?snapped:points.map(p=>[...p]);
  });
  // Merge overlap and tiny measured breaks, preserving real openings. Restart
  // after a merge so a chain of fragments becomes one edge, independent of order.
  let changed=true;
  while(changed){changed=false;
    outer:for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
      const [a,b]=lines[i],[c,d]=lines[j],length=Math.hypot(b[0]-a[0],b[1]-a[1]),other=Math.hypot(d[0]-c[0],d[1]-c[1]);
      const u=[(b[0]-a[0])/length,(b[1]-a[1])/length];
      if(Math.abs(u[0]*(d[1]-c[1])-u[1]*(d[0]-c[0]))/other>Math.sin(Math.PI/22.5))continue;
      const project=p=>(p[0]-a[0])*u[0]+(p[1]-a[1])*u[1],offset=p=>(p[1]-a[1])*u[0]-(p[0]-a[0])*u[1];
      if(Math.max(Math.abs(offset(c)),Math.abs(offset(d)))>.12)continue;
      const lo=Math.min(project(c),project(d)),hi=Math.max(project(c),project(d));
      if(Math.max(0,lo-length,-hi)>.15)continue;
      const shift=(offset(c)+offset(d))/2*other/(length+other),origin=[a[0]-shift*u[1],a[1]+shift*u[0]];
      const joined=[Math.min(0,lo),Math.max(length,hi)].map(t=>origin.map((v,k)=>v+t*u[k]));
      if(!supported(joined))continue;
      lines[i]=joined;lines.splice(j,1);changed=true;break outer;
    }
  }
  // Nearby perpendicular endpoints become a single shared vertex. Never close
  // a gap through known free space or extend a wall beyond measured support.
  for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
    const [a,b]=lines[i],[c,d]=lines[j],u=[b[0]-a[0],b[1]-a[1]],v=[d[0]-c[0],d[1]-c[1]],det=u[0]*v[1]-u[1]*v[0];
    if(Math.abs(det)<.95*Math.hypot(...u)*Math.hypot(...v))continue;
    const t=((c[0]-a[0])*v[1]-(c[1]-a[1])*v[0])/det,p=a.map((x,k)=>x+t*u[k]);
    const end=line=>Math.hypot(line[0][0]-p[0],line[0][1]-p[1])<Math.hypot(line[1][0]-p[0],line[1][1]-p[1])?0:1;
    const ei=end(lines[i]),ej=end(lines[j]);
    if(Math.hypot(...lines[i][ei].map((x,k)=>x-p[k]))>.2 || Math.hypot(...lines[j][ej].map((x,k)=>x-p[k]))>.2)continue;
    if(!occupied(p))continue;
    const li=lines[i].map((q,k)=>k===ei?p:q),lj=lines[j].map((q,k)=>k===ej?p:q);
    if(supported(li)&&supported(lj)){lines[i]=li;lines[j]=lj;}
  }
  return lines;
}
