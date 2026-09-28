import clipping from 'polygon-clipping';

// The connected observed floor is separate from wall evidence. In particular,
// an edge against unobserved space is an unfinished boundary, never a new wall.
export function floorGeometry(cells,axis=0,walls=[],poses=null) {
 const size=.1,c=Math.cos(axis||0),s=Math.sin(axis||0),counts=new Map();
 const key=(x,y)=>`${x},${y}`;
 for(const [ix,iy,v] of cells){
  const x=(ix+.5)*.05,y=(iy+.5)*.05,k=key(Math.floor((x*c+y*s)/size),Math.floor((-x*s+y*c)/size));
  const q=counts.get(k)||[0,0];q[v<0?0:1]++;counts.set(k,q);
 }
 const free=new Set([...counts].filter(([,q])=>q[0]>=2 && q[0]>q[1]).map(([k])=>k));
 // Remove thin ray slivers without expanding the floor into unknown rooms.
 const floor=new Set();
 for(const k of free){const [x,y]=k.split(',').map(Number);let n=0;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if(free.has(key(x+dx,y+dy)))n++;if(n>=5)floor.add(k);}
 const rows=new Map();for(const k of floor){const [x,y]=k.split(',').map(Number);if(!rows.has(y))rows.set(y,[]);rows.get(y).push(x);}
 const rectangles=[];
 for(const [y,xs] of rows){xs.sort((a,b)=>a-b);let start=xs[0];for(let i=1;i<=xs.length;i++)if(i===xs.length||xs[i]>xs[i-1]+1){const x1=start*size,x2=(xs[i-1]+1)*size,y1=y*size,y2=(y+1)*size;rectangles.push([[[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]]]);start=xs[i];}}
 if(!rectangles.length)return {geometry:[],boundary:[],area:0};
 const signed=r=>r.slice(1).reduce((v,b,i)=>v+r[i][0]*b[1]-b[0]*r[i][1],0)/2;
 const simplify=ring=>{
  const distance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
  const reduce=points=>{
   if(points.length<=2)return points;
   let best=.14,index=-1;
   for(let i=1;i<points.length-1;i++){const d=distance(points[i],points[0],points.at(-1));if(d>best){best=d;index=i;}}
   return index<0?[points[0],points.at(-1)]:[...reduce(points.slice(0,index+1)).slice(0,-1),...reduce(points.slice(index))];
  };
  const points=ring.slice(0,-1);let split=1;
  for(let i=2;i<points.length;i++)if(Math.hypot(...points[i].map((v,k)=>v-points[0][k]))>Math.hypot(...points[split].map((v,k)=>v-points[0][k])))split=i;
  const simple=[...reduce(points.slice(0,split+1)).slice(0,-1),...reduce([...points.slice(split),points[0]]).slice(0,-1)];
  if(simple.length<4)return ring;
  // Regularize the measured contour in the dominant wall frame. Adjacent
  // edges share intersections, so the result is a connected polygon, not logs.
  const lines=simple.map((a,i)=>{
   const b=simple[(i+1)%simple.length],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.atan2(dy,dx),target=Math.round(t/(Math.PI/2))*Math.PI/2;
   const snapped=Math.abs(t-target)<Math.PI/9 && Math.hypot(dx,dy)*Math.sin(Math.abs(t-target))/2<.18;
   return {p:[(a[0]+b[0])/2,(a[1]+b[1])/2],u:snapped?[Math.cos(target),Math.sin(target)]:[dx,dy]};
  });
  const out=simple.map((point,i)=>{
   const a=lines[(i+lines.length-1)%lines.length],b=lines[i],det=a.u[0]*b.u[1]-a.u[1]*b.u[0];
   if(Math.abs(det)<1e-6)return point;
   const t=((b.p[0]-a.p[0])*b.u[1]-(b.p[1]-a.p[1])*b.u[0])/det,p=a.p.map((v,k)=>v+t*a.u[k]);
   return Math.hypot(p[0]-point[0],p[1]-point[1])<.2?p:point;
  });
  return [...out,out[0]];
 };
 let geometry=clipping.union(...rectangles).filter(p=>Math.abs(signed(p[0]))>=.4).map(p=>p.filter((r,i)=>i===0||Math.abs(signed(r))>=.15).map(simplify));
 // Polygon clipping normalizes rings after simplification and keeps hole roles.
 geometry=geometry.length?clipping.union(...geometry):[];
 const world=([x,y])=>[x*c-y*s,x*s+y*c];
 geometry=geometry.map(p=>p.map(r=>r.map(world)));
 if(poses?.length){
  const inside=(p,r)=>{let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if((a[1]>p.y)!=(b[1]>p.y)&&p.x<(b[0]-a[0])*(p.y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
  const visited=geometry.filter(p=>poses.some(q=>inside(q,p[0])&&!p.slice(1).some(r=>inside(q,r))));
  if(visited.length)geometry=visited;
 }
 const occupied=new Set(cells.filter(q=>q[2]>=2).map(([x,y])=>key(x,y)));
 const boundary=[];
 const structural=walls.filter(([a,b])=>{
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]),angle=Math.atan2(b[1]-a[1],b[0]-a[0])-(axis||0);
  const error=Math.abs(Math.atan2(Math.sin(4*angle),Math.cos(4*angle))/4);
  return length>=1.2 && error<Math.PI/18;
 });
 const nearWall=p=>structural.some(([a,b])=>{
  const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)<.22;
 });
 for(const polygon of geometry)for(const [ringIndex,ring] of polygon.entries())for(let i=1;i<ring.length;i++){
  const a=ring[i-1],b=ring[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.max(1,Math.ceil(length/.1));let hits=0,wallHits=0;
  for(let j=0;j<n;j++){const t=(j+.5)/n,x=Math.floor((a[0]+t*(b[0]-a[0]))/.05),y=Math.floor((a[1]+t*(b[1]-a[1]))/.05);let hit=false;
   for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)if(occupied.has(key(x+dx,y+dy)))hit=true;
   if(hit)hits++;
   if(nearWall([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]))wallHits++;
  }
  boundary.push({points:[a,b],kind:ringIndex===0&&wallHits/n>=.7?'wall':hits/n>=.65?'obstacle':'unobserved'});
 }
 const area=geometry.reduce((sum,p)=>sum+Math.abs(signed(p[0]))-p.slice(1).reduce((s,r)=>s+Math.abs(signed(r)),0),0);
 return {geometry,boundary,area};
}
