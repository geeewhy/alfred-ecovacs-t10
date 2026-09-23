import clipping from 'polygon-clipping';
export const area = g => g.reduce((sum,p) => sum + p.reduce((s,r,i) => s + (i ? -1 : 1)*Math.abs(r.reduce((v,a,j)=>{const b=r[(j+1)%r.length];return v+a[0]*b[1]-b[0]*a[1];},0))/2,0),0);
export function polygon(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 500 || points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||Math.abs(n)>1000))) throw Error('Draw at least three valid points.');
  const ring = [...points.map(p=>[...p])];
  if (ring[0][0]===ring.at(-1)[0] && ring[0][1]===ring.at(-1)[1]) ring.pop();
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=0;i<ring.length;i++) for(let j=i+2;j<ring.length;j++) {
    if(i===0&&j===ring.length-1)continue;
    const a=ring[i],b=ring[(i+1)%ring.length],c=ring[j],d=ring[(j+1)%ring.length];
    if(cross(a,b,c)*cross(a,b,d)<=0 && cross(c,d,a)*cross(c,d,b)<=0 && Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0])) && Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]))) throw Error('Polygon edges must not cross or touch.');
  }
  ring.push([...ring[0]]); const result=clipping.union([ring]);
  if(area(result)<0.01)throw Error('Area is too small.');return result;
}
export function split(geometry,a,b) {
  if(![a,b].every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))throw Error('Choose two points for the split.');
  const len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(len<0.01)throw Error('Split line is too short.');
  const dx=(b[0]-a[0])/len,dy=(b[1]-a[1])/len,L=10000;
  const p=[a[0]-dx*L,a[1]-dy*L],q=[a[0]+dx*L,a[1]+dy*L];
  const half=[p,q,[q[0]-dy*L,q[1]+dx*L],[p[0]-dy*L,p[1]+dx*L],p];
  const parts=[clipping.intersection(geometry,[half]),clipping.difference(geometry,[half])];
  if(parts.some(g=>area(g)<0.01))throw Error('The line must cross the selected area.');return parts;
}
export const merge = geometries => clipping.union(...geometries);
