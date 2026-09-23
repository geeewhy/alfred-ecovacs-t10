// Measured LiDAR only. Units at the engine boundary are millimetres.
export function transform(points,p) {const c=Math.cos(p.theta),s=Math.sin(p.theta);return points.map(([x,y])=>[c*x-s*y+p.x,s*x+c*y+p.y]);}
export function align(points,reference,initial={x:0,y:0,theta:0}) {
  let pose={...initial},rms=Infinity,coverage=0;
  for(let step=0;step<18;step++) {
    const source=transform(points,pose),pairs=[];
    for(const p of source){let best=null,d=.35**2;for(const q of reference){const n=(p[0]-q[0])**2+(p[1]-q[1])**2;if(n<d){d=n;best=q;}}if(best)pairs.push([p,best,d]);}
    pairs.sort((a,b)=>a[2]-b[2]); coverage=pairs.length/points.length;
    const kept=pairs.slice(0,Math.ceil(pairs.length*.85));if(kept.length<30)return {ok:false,pose,rms,coverage};
    const mean=side=>kept.reduce((s,p)=>[s[0]+p[side][0]/kept.length,s[1]+p[side][1]/kept.length],[0,0]);
    const a=mean(0),b=mean(1);let dot=0,cross=0;
    for(const [p,q] of kept){const x=p[0]-a[0],y=p[1]-a[1],u=q[0]-b[0],v=q[1]-b[1];dot+=x*u+y*v;cross+=x*v-y*u;}
    const angle=Math.atan2(cross,dot),c=Math.cos(angle),s=Math.sin(angle),tx=b[0]-c*a[0]+s*a[1],ty=b[1]-s*a[0]-c*a[1];
    pose={x:c*pose.x-s*pose.y+tx,y:s*pose.x+c*pose.y+ty,theta:pose.theta+angle};
    rms=Math.sqrt(kept.reduce((s,p)=>s+p[2],0)/kept.length);
    if(Math.hypot(tx,ty)<.0005&&Math.abs(angle)<.0005)break;
  }
  return {ok:coverage>.65&&rms<.09&&Math.hypot(pose.x-initial.x,pose.y-initial.y)<.3&&Math.abs(pose.theta-initial.theta)<.3,pose,rms,coverage};
}
export class Scanner {
  constructor(){this.pose={x:0,y:0,theta:0};this.reference=null;this.cells=new Map();this.frames=0;this.lastSequence=null;}
  ingest(scan){
    if(!scan||Date.now()-scan.observed_at_unix_ms>2000||scan.sequence===this.lastSequence)throw Error('Waiting for fresh LiDAR.');
    const points=scan.points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.hypot(p.x,p.y)>120&&Math.hypot(p.x,p.y)<12000).filter((_,i)=>i%2===0).map(p=>[p.x/1000,p.y/1000]);
    if(points.length<60)throw Error('Not enough LiDAR returns.');this.lastSequence=scan.sequence;
    let quality={rms:0,coverage:1};
    if(this.reference){quality=align(points,this.reference,this.pose);if(!quality.ok)throw Error('Alignment lost. Stop moving; return to the last mapped position or start a new scan.');this.pose=quality.pose;}
    const world=transform(points,this.pose);this.reference=world;this.frames++;
    const mark=(x,y,n)=>{if(Math.abs(x)>600||Math.abs(y)>600)return;const k=`${x},${y}`;this.cells.set(k,Math.max(-8,Math.min(8,(this.cells.get(k)||0)+n)));};
    for(const [x,y] of world){const dx=x-this.pose.x,dy=y-this.pose.y,steps=Math.ceil(Math.hypot(dx,dy)/.05);for(let i=0;i<steps-1;i++)mark(Math.floor((this.pose.x+dx*i/steps)/.05),Math.floor((this.pose.y+dy*i/steps)/.05),-1);mark(Math.floor(x/.05),Math.floor(y/.05),3);}
    return {frames:this.frames,pose:this.pose,rms:quality.rms,coverage:quality.coverage};
  }
  grid(){return [...this.cells].map(([k,v])=>[...k.split(',').map(Number),v]);}
}
export function outlines(cells){
  const occupied=new Set(cells.filter(c=>c[2]>=2).map(c=>`${c[0]},${c[1]}`)),lines=[];
  for(const key of occupied){const [x,y]=key.split(',').map(Number);for(const [dx,dy,a,b] of [[0,-1,[x,y],[x+1,y]],[1,0,[x+1,y],[x+1,y+1]],[0,1,[x+1,y+1],[x,y+1]],[-1,0,[x,y+1],[x,y]]])if(!occupied.has(`${x+dx},${y+dy}`))lines.push([a.map(n=>n*.05),b.map(n=>n*.05)]);}
  return lines;
}
