const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const path=g=>g.flatMap(p=>p.map(r=>'M'+r.map(([x,y])=>`${x},${-y}`).join('L')+'Z')).join('');
export function sectionAnchor(geometry) {
  const inside=([x,y],r)=>{let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if((a[1]>y)!=(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
  let best=-1,result=geometry[0][0][0];
  for(const polygon of geometry){
    const xs=polygon[0].map(p=>p[0]),ys=polygon[0].map(p=>p[1]),x=Math.min(...xs),X=Math.max(...xs),y=Math.min(...ys),Y=Math.max(...ys);
    for(let i=1;i<16;i++)for(let j=1;j<16;j++){
      const p=[x+(X-x)*i/16,y+(Y-y)*j/16];if(!inside(p,polygon[0])||polygon.slice(1).some(r=>inside(p,r)))continue;
      let distance=Infinity;
      for(const ring of polygon)for(let k=1;k<ring.length;k++){const a=ring[k-1],b=ring[k],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));distance=Math.min(distance,Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy));}
      if(distance>best){best=distance;result=p;}
    }
  }
  return result;
}
export function selectionCorners(a,b,angle) {
  const c=Math.cos(angle),s=Math.sin(angle),rotate=([x,y])=>[x*c+y*s,-x*s+y*c],back=([x,y])=>[x*c-y*s,x*s+y*c];
  const A=rotate(a),B=rotate(b);
  return [[A[0],A[1]],[B[0],A[1]],[B[0],B[1]],[A[0],B[1]]].map(back);
}
export const sectionsMarkup=()=>`<section class="map-sections" aria-labelledby="sections-title"><div class="sections-heading"><h2 id="sections-title">Sections</h2><button id="section-add" type="button">Name section</button></div><p id="sections-intro" class="map-muted">Give Alfred names for places you talk about.</p><div id="section-list"></div><form id="section-form" hidden><p id="section-step" role="status"></p><label for="section-name">Section name</label><input id="section-name" maxlength="48" required autocomplete="off" placeholder="e.g. Living room"><div class="section-suggestions" aria-label="Common section names">${['Kitchen','Living room','Bedroom','Hallway'].map(n=>`<button type="button" data-section-name="${n}">${n}</button>`).join('')}</div><label for="section-aliases">Also called <span class="map-muted">(optional)</span></label><input id="section-aliases" maxlength="390" placeholder="Lounge, by the sofa" aria-describedby="section-alias-help"><p id="section-alias-help" class="map-muted">Separate names with commas. Alfred knows they mean the same place.</p><p id="section-example" class="section-example"></p><p id="section-error" role="alert"></p><div class="section-actions"><button id="section-save" type="submit">Save section</button><button id="section-cancel" type="button">Cancel</button></div><div class="section-secondary"><button id="section-reselect" type="button">Change area</button><button id="section-remove" type="button">Remove section</button></div></form><div id="section-undo" hidden role="status"><span>Section removed.</span> <button type="button">Undo</button></div></section>`;

export function mountSections({getMap,render,edit,stopDrive}) {
  const $=s=>document.querySelector(s),form=$('#section-form'),svg=$('#map-svg');
  let mapId=null,signature='',draft=null,selecting=false,first=null,drag=null,saving=false,undoRevision=null;
  const error=text=>{$('#section-error').textContent=text;};
  function fields(){
    const name=$('#section-name').value.trim();
    $('#section-example').textContent=name?`Alfred will know “${name}” when you mention it.`:'';
    $('#section-save').disabled=saving||!name||!draft||(!draft.geometry&&!draft.points)||selecting;
  }
  function close(){draft=null;selecting=false;first=null;drag=null;form.hidden=true;svg.dataset.sectionSelecting='false';error('');render(false);}
  function sync(){
    const map=getMap();
    if(map?.id!==mapId){mapId=map?.id;signature='';draft=null;selecting=false;first=null;drag=null;form.hidden=true;undoRevision=null;}
    $('#section-add').disabled=!map?.structure?.floor?.geometry?.length||saving;
    $('#sections-intro').textContent=!map?.structure?.floor?.geometry?.length?'Scan a floor first, then give its sections names.':'Give Alfred names for places you talk about.';
    const next=JSON.stringify([map?.id,map?.areas,draft?.id]);
    if(signature!==next){signature=next;$('#section-list').innerHTML=(map?.areas||[]).map(a=>`<button type="button" class="section-row" data-section-id="${esc(a.id)}" aria-pressed="${draft?.id===a.id}"><span>${esc(a.name)}<small>${a.aliases?.length?esc(a.aliases.join(' · ')):'Click to edit'}</small></span><span>${a.area.toFixed(1)} m²</span></button>`).join('');}
    $('#section-undo').hidden=undoRevision!==map?.revision;
    svg.dataset.sectionSelecting=String(selecting);
  }
  async function begin(id){
    if(saving)return;
    const map=getMap();if(!map)return;
    const section=map.areas.find(a=>a.id===id);
    // Release held manual controls before entering spatial editing.
    try{await stopDrive();}catch(e){$('#sections-intro').textContent=e.message;return;}
    if(getMap()?.id!==map.id)return;
    draft=section?structuredClone(section):{id:null};selecting=!section;first=null;drag=null;undoRevision=null;
    form.hidden=false;error('');$('#section-name').value=section?.name||'';$('#section-aliases').value=(section?.aliases||[]).join(', ');
    $('#section-step').textContent=section?'Edit this section.':'Drag over the section, or tap two opposite corners.';
    $('#section-reselect').hidden=!section;$('#section-remove').hidden=!section;
    fields();render(false);
    if(section)$('#section-name').focus();else svg.focus();
    form.scrollIntoView({block:'nearest',behavior:'instant'});
  }
  function finish(p){
    const points=selectionCorners(first,p,(getMap()?.displayAngle||0)*Math.PI/180);
    if(Math.hypot(points[1][0]-points[0][0],points[1][1]-points[0][1])<.2||Math.hypot(points[2][0]-points[1][0],points[2][1]-points[1][1])<.2){error('Choose a wider area, then try again.');first=null;drag=null;return;}
    draft.points=points;selecting=false;first=null;drag=null;error('');
    $('#section-step').textContent='Highlighted floor becomes this section. Give it a name.';
    $('#section-reselect').hidden=false;fields();render(false);$('#section-name').focus();
  }
  $('#section-add').onclick=()=>begin();
  $('#section-list').onclick=e=>{const b=e.target.closest('[data-section-id]');if(b)begin(b.dataset.sectionId);};
  $('#section-cancel').onclick=()=>{close();$('#section-add').focus();};
  $('#section-reselect').onclick=()=>{if(saving)return;selecting=true;first=null;draft.pendingCorner=false;draft.points=null;$('#section-step').textContent='Drag over the section, or tap two opposite corners.';fields();render(false);svg.focus();};
  $('#section-name').oninput=fields;
  form.querySelectorAll('[data-section-name]').forEach(b=>b.onclick=()=>{$('#section-name').value=b.dataset.sectionName;fields();$('#section-name').focus();});
  function lock(value){saving=value;for(const control of form.elements)control.disabled=value;fields();$('#section-add').disabled=value||!getMap()?.structure?.floor?.geometry?.length;}
  form.onsubmit=async e=>{
    e.preventDefault();if(saving||selecting||!draft)return;
    const id=getMap()?.id,payload={action:'save-section',id:draft.id||undefined,name:$('#section-name').value,aliases:$('#section-aliases').value.split(',').map(s=>s.trim()).filter(Boolean),...(draft.points?{points:draft.points}:{})};
    lock(true);error('');
    try{await edit(payload);if(getMap()?.id===id){close();$('#section-add').focus();}}
    catch(e){if(getMap()?.id===id)error(e.message);}
    finally{lock(false);}
  };
  $('#section-remove').onclick=async()=>{
    if(saving||!draft?.id)return;
    lock(true);error('');const id=getMap()?.id;
    try{await edit({action:'delete',ids:[draft.id]});if(getMap()?.id===id){undoRevision=getMap().revision;close();$('#section-undo button').focus();}}
    catch(e){error(e.message);}finally{lock(false);}
  };
  $('#section-undo button').onclick=async()=>{
    if(saving||getMap()?.revision!==undoRevision)return;
    lock(true);
    try{await edit({action:'undo'});undoRevision=null;render(false);}catch(e){$('#sections-intro').textContent=e.message;}finally{lock(false);}
  };
  const escape=e=>{if(e.key==='Escape'&&draft&&!saving){e.preventDefault();close();$('#section-add').focus();}};
  window.addEventListener('keydown',escape);
  return {
    sync,
    get editing(){return !!draft;},
    down(e,p){
      if(saving)return true;
      if(!selecting)return false;
      if(!first)first=p;
      drag={x:e.clientX,y:e.clientY,second:!!draft?.pendingCorner};
      draft.pendingCorner=true;draft.points=selectionCorners(first,p,(getMap()?.displayAngle||0)*Math.PI/180);render(false);return true;
    },
    move(e,p){if(!selecting||!first)return false;draft.points=selectionCorners(first,p,(getMap()?.displayAngle||0)*Math.PI/180);render(false);return true;},
    up(e,p){if(!selecting||!drag)return false;const moved=Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>5;if(moved||drag.second){draft.pendingCorner=false;finish(p);}else{drag=null;$('#section-step').textContent='Tap the opposite corner.';}return true;},
    cancelPointer(){if(selecting){first=null;drag=null;draft.points=null;draft.pendingCorner=false;render(false);}},
    select(id){begin(id);},
    overlay(){
      const map=getMap();if(!map)return '';
      const angle=map.displayAngle||0, matrix=svg.getScreenCTM(), font=12/(matrix?Math.hypot(matrix.a,matrix.b):60);
      let html=(map.areas||[]).map(a=>{
        const center=sectionAnchor(a.geometry);
        return `<g data-section-id="${esc(a.id)}" class="map-section${draft?.id===a.id?' is-selected':''}"><title>${esc(a.name)}</title><path d="${path(a.geometry)}" fill="oklch(0.55 0.17 265 / 0.09)" stroke="oklch(0.55 0.17 265 / 0.5)" stroke-width="1" vector-effect="non-scaling-stroke" fill-rule="evenodd"/><text transform="translate(${center[0]},${-center[1]}) rotate(${-angle})" text-anchor="middle" font-size="${font}" font-family="system-ui,sans-serif" font-weight="600" fill="oklch(0.35 0.10 265)" stroke="oklch(0.992 0.002 250)" stroke-width="${font*.25}" paint-order="stroke">${esc(a.name)}</text></g>`;
      }).join('');
      if(draft?.points){const d=path([[draft.points]]);html+=`<defs><clipPath id="section-floor-clip"><path d="${path(map.structure.floor.geometry)}" clip-rule="evenodd"/></clipPath></defs><path d="${d}" fill="oklch(0.55 0.17 265 / .22)" clip-path="url(#section-floor-clip)" pointer-events="none"/><path d="${d}" fill="none" stroke="oklch(0.55 0.17 265)" stroke-width="1.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" pointer-events="none"/>`;}
      return html;
    },
    dispose(){window.removeEventListener('keydown',escape);}
  };
}
