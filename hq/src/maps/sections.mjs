import clipping from 'polygon-clipping';
import { polygon, area } from './geometry.mjs';

export const normalizeSectionName = value => String(value).normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/^(the|a|an) /,'');
function label(value) {
  if(typeof value !== 'string' || !value.trim() || value.trim().length>48 || /[\p{Cc}\p{Cf}]/u.test(value)) throw Error('Use a section name of 1–48 characters.');
  if(!normalizeSectionName(value)) throw Error('Use letters or numbers in the section name.');
  return value.trim();
}
export function sectionNames(name, aliases=[], others=[]) {
  name=label(name);
  if(!Array.isArray(aliases) || aliases.length>8)throw Error('Use up to 8 alternative names.');
  const seen=new Set([normalizeSectionName(name)]), clean=[];
  for(const raw of aliases){const text=label(raw),key=normalizeSectionName(text);if(!seen.has(key)){seen.add(key);clean.push(text);}}
  for(const other of others)for(const text of [other.name,...(other.aliases||[])])if(seen.has(normalizeSectionName(text)))throw Error(`“${text}” already refers to another section on this map.`);
  return {name,aliases:clean};
}
export function sectionGeometry(map, points) {
  if(!map.structure?.floor?.geometry?.length)throw Error('A mapped floor is needed before naming sections.');
  const geometry=clipping.intersection(polygon(points),map.structure.floor.geometry);
  if(area(geometry)<0.25)throw Error('Select at least 0.25 m² of mapped floor.');
  return geometry;
}
export function containsPoint(geometry,[x,y]) {
  const inside=r=>{let hit=false;for(let i=0,j=r.length-1;i<r.length;j=i++){
    const a=r[i],b=r[j];if((a[1]>y)!=(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;
  }return hit;};
  return geometry.some(p=>inside(p[0])&&!p.slice(1).some(inside));
}
// Read-only destination proposal, never a claim that a live route is clear.
export function sectionTarget(map, section) {
  const grid=map.checkpoint?.nativeGrid;
  if(!grid?.cells?.length)return null;
  const {resolution:r,width,height,origin}=grid;
  const free=new Set(grid.cells.filter(c=>c[2]===127).map(([x,y])=>y*width+x));
  for(const [x,y,v] of grid.cells)if(v===129)free.delete(y*width+x);
  const candidates=[];let sx=0,sy=0;
  for(const index of free){const x=index%width,y=Math.floor(index/width),p=[origin[0]+(x+.5)*r,origin[1]+(y+.5)*r];if(containsPoint(section.geometry,p)){candidates.push([x,y,p]);sx+=p[0];sy+=p[1];}}
  if(!candidates.length)return null;
  const center=[sx/candidates.length,sy/candidates.length],n=Math.ceil(.25/r);
  candidates.sort((a,b)=>Math.hypot(a[2][0]-center[0],a[2][1]-center[1])-Math.hypot(b[2][0]-center[0],b[2][1]-center[1]));
  for(const [x,y,p] of candidates){let clear=true;
    for(let dx=-n;dx<=n&&clear;dx++)for(let dy=-n;dy<=n;dy++)if((dx*dx+dy*dy)*r*r<=.25*.25){const X=x+dx,Y=y+dy;if(X<0||Y<0||X>=width||Y>=height||!free.has(Y*width+X)){clear=false;break;}}
    if(clear)return {x:p[0],y:p[1],theta:0};
  }
  return null;
}
