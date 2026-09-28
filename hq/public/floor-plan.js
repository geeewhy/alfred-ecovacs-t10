const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function roomLabel(area, rotation=0) {
 const ring=area.geometry[0][0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);
 const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 const inside=([x,y],r)=>{let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if((a[1]>y)!=(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
 let center=[(minX+maxX)/2,(minY+maxY)/2],best=-Infinity;
 for(let i=1;i<15;i++)for(let j=1;j<15;j++) {
  const p=[minX+(maxX-minX)*i/15,minY+(maxY-minY)*j/15];
  if(!inside(p,ring)||area.geometry[0].slice(1).some(r=>inside(p,r)))continue;
  let distance=Infinity;
  for(let k=1;k<ring.length;k++){const a=ring[k-1],b=ring[k],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));distance=Math.min(distance,Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy));}
  if(distance>best){best=distance;center=p;}
 }
 return `<text transform="rotate(${-rotation} ${center[0]} ${-center[1]})" x="${center[0]}" y="${-center[1]}" text-anchor="middle" font-family="Arial,sans-serif" fill="#202020" pointer-events="none" stroke="#fff" stroke-width=".04" paint-order="stroke"><tspan x="${center[0]}" font-size=".18">${esc(area.name.toUpperCase())}</tspan><tspan x="${center[0]}" dy=".23" font-size=".13">${area.area.toFixed(1)} m²</tspan></text>`;
}
export function planDetails(map,dimensions=true) {
 let result='';
 for(const f of map?.features||[]) {
  const [a,b]=f.points,w=Math.hypot(b[0]-a[0],b[1]-a[1]),angle=-Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI;
  result+=`<g transform="translate(${a[0]},${-a[1]}) rotate(${angle})" data-feature="${f.id}"><path d="M0 0H${w}" stroke="#fff" stroke-width=".16"/>${f.kind==='door'?`<path d="M0 0V${-w}M0 ${-w}A${w} ${w} 0 0 1 ${w} 0" fill="none" stroke="#333" stroke-width=".018"/>`:`<path d="M0 -.035H${w}M0 0H${w}M0 .035H${w}M0 -.06V.06M${w} -.06V.06" fill="none" stroke="#333" stroke-width=".012"/>`}<path data-feature="${f.id}" d="M0 0H${w}" stroke="transparent" stroke-width=".22"/></g>`;
 }
 return result;
}
export function planDimensions(map,dimensions=true) {
 let result="";
 const angle=(map?.displayAngle||0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
 const points=(map?.structure?.floor?.geometry?.length ? map.structure.floor.geometry.flat(2) : (map?.vectors||[]).flat()).map(([x,y])=>[x*c+y*s,-x*s+y*c]);
 if(!dimensions||points.length<2)return result;
 const xs=points.map(p=>p[0]),ys=points.map(p=>-p[1]),x=Math.min(...xs),X=Math.max(...xs),y=Math.min(...ys),Y=Math.max(...ys),top=y-.45,left=x-.45;
 result+=`<g fill="none" stroke="#9c699e" stroke-width=".012"><path d="M${x} ${y-.12}V${top-.08}M${X} ${y-.12}V${top-.08}M${x} ${top}H${X}M${x-.12} ${y}H${left-.08}M${x-.12} ${Y}H${left-.08}M${left} ${y}V${Y}"/></g><g fill="#825184" font-family="Arial,sans-serif" font-size=".15" text-anchor="middle" stroke="#fff" stroke-width=".07" paint-order="stroke"><text x="${(x+X)/2}" y="${top-.08}">${(X-x).toFixed(2)} m</text><text transform="translate(${left-.1},${(y+Y)/2}) rotate(-90)">${(Y-y).toFixed(2)} m</text></g><text x="${(x+X)/2}" y="${Y+.6}" text-anchor="middle" font-family="Arial,sans-serif" font-size=".22" fill="#222">${esc((map.name||'Floor plan').toUpperCase())}</text><path d="M${(x+X)/2-.8} ${Y+.74}h1.6" stroke="#222" stroke-width=".018"/>`;
 return result;
}

export function floorSurface(map) {
 const floor=map?.structure?.floor;
 if(!floor?.geometry?.length)return '';
 const outline=floor.geometry.flatMap(p=>p.map(r=>'M'+r.map(([x,y])=>`${x},${-y}`).join('L')+'Z')).join('');
 const edges=kind=>floor.boundary.filter(e=>e.kind===kind).map(({points:[a,b]})=>`M${a[0]},${-a[1]}L${b[0]},${-b[1]}`).join('');
 return `<path d="${outline}" fill="#f0f2f3" fill-rule="evenodd"/><path d="${edges('wall')}" fill="none" stroke="#465760" stroke-width=".035" stroke-linejoin="miter"/><path d="${edges('obstacle')}" fill="none" stroke="#687f8c" stroke-width=".035" stroke-linejoin="round"/><path d="${edges('unobserved')}" fill="none" stroke="#77828c" stroke-width=".025" stroke-dasharray=".09 .07"/>`;
}

export function boundaryMarkers(map) {
 return (map?.scan?.boundaryMarkers||[]).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map((p,i)=>`<g class="map-boundary-marker" role="img" aria-label="Unmapped boundary ${i+1}" transform="translate(${p.x},${-p.y})"><title>Unmapped boundary ${i+1}: needs another approach</title><circle r=".13" fill="#c63535" stroke="#fff" stroke-width=".035"/><text transform="rotate(${-(map.displayAngle||0)})" text-anchor="middle" dy=".042" font-size=".12" font-family="Arial,sans-serif" font-weight="700" fill="#fff" pointer-events="none">${i+1}</text></g>`).join('');
}

export function stationMarker(map) {
 const s=map?.station;
 if(!s || !Number.isFinite(s.x) || !Number.isFinite(s.y))return '';
 return `<g class="map-station-marker" role="img" aria-label="Charging station" transform="translate(${s.x},${-s.y}) rotate(${-(map.displayAngle||0)})"><title>Station: verified docked position</title><rect x="-.16" y="-.16" width=".32" height=".32" rx=".05" fill="#356c62" stroke="#f4f7f6" stroke-width=".025"/><path d="M.025 -.12L-.07 .015H0L-.025 .12L.08 -.015H.01Z" fill="#f4f7f6"/><text y=".34" text-anchor="middle" font-size=".15" fill="#28493f" stroke="#f4f7f6" stroke-width=".035" paint-order="stroke">Station</text></g>`;
}
