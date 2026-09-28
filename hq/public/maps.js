import {stationMarker,boundaryMarkers,floorSurface, planDetails,planDimensions} from "./floor-plan.js";
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function mapsPage(controls = "", settings = "") {
  return `<section class="maps-page"><header class="maps-heading"><div><span class="eyebrow">ALFRED / SPATIAL</span><h1>Maps</h1></div><div><select id="map-select" aria-label="Saved map"></select><button id="map-new">New map</button></div></header><div class="map-toolbar"><select id="scan-mode" aria-label="Scan mode"><option value="explore">Explore automatically</option><option value="deep">Deep pass · verify all walls</option><option value="manual">Manual capture</option></select><label class="scan-duration"><input id="scan-minutes" type="number" value="10" min="1" max="60" aria-label="Maximum scan minutes"> min</label><button data-scan="start">Start scan</button><button data-scan="pause">Pause</button><button data-scan="resume">Resume</button><button data-scan="locate" title="May move a short distance to find a clearer view">Locate Alfred</button><button data-scan="finish">Finish scan</button><button id="map-emergency">Stop movement</button></div><div class="map-scan-progress" role="status" aria-live="polite"><strong id="map-scan-state">No scan</strong><span id="map-scan-detail">Create or choose a map.</span><small id="map-sensors"></small></div><div class="map-workspace"><div class="map-stage"><div class="map-tools"><button id="map-fit">Fit</button><label><input id="map-vector" type="checkbox" checked> Floor plan</label><label><input id="map-measurements" type="checkbox"> Measurements</label><label><input id="map-dimensions" type="checkbox" checked> Dimensions</label></div><svg id="map-svg" role="img" aria-label="Live floor plan" tabindex="0" viewBox="-5 -5 10 10"></svg><div id="map-plan-empty" class="map-plan-empty" hidden>Building the floor plan from the live scan.</div><div class="map-legend" aria-label="Map legend"><span class="map-key-wall">Likely walls</span><span class="map-key-obstacle">Obstacles</span><span class="map-key-unknown">Unscanned</span><span id="map-deep-legend" hidden>Deep pass: green checked · amber pending · blue current</span></div><div id="map-hint">Create a map to begin.</div></div><aside class="map-inspector"><section id="map-manual-controls" hidden>${controls}</section><p id="map-position-status" role="status">Position: waiting</p><label>Map name<input id="map-name" maxlength="80"></label><button id="map-rename">Save name</button><h2>Station</h2><p id="map-station-status" class="map-muted"></p><button data-scan="locate" data-station="true" title="May briefly leave the dock to verify its map position">Locate station</button><button id="map-return-onboard">Return onboard</button><button id="map-return">HQ-guided return (backup)</button><p id="engine-return-status" class="map-muted" role="status"></p><hr><button id="map-svg-export">Export SVG</button><button id="map-png-export">Export PNG</button><hr><label>Plan rotation<input id="map-rotation" type="number" step="1" placeholder="Automatic wall alignment"></label><button id="map-set-rotation">Apply rotation</button><hr><button id="map-delete">Delete map</button></aside></div><p id="map-message" role="status" aria-live="polite"></p>${settings}</section>`;
}
export function mountMaps({stopDrive = ()=>{}} = {}) {
  let alive = true,
    map = null,
    livePose = null,
    poseTimer,
    poseReceived = 0,
    dock = null,
    onboard = null,
    dockCheckedAt = 0,
    view = [-5, -5, 10, 10],
    timer,
    angle = 0,
    busy = false,
    pointer = null;
  const $ = (s) => document.querySelector(s),
    svg = $("#map-svg");
  const message = (s) => {
    if (alive) $("#map-message").textContent = s;
  };
  async function api(path = "", body, method) {
    const response = await fetch("/api/maps" + path, {
      method: method || (body ? "POST" : "GET"),
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!data.ok) {
      if (data.error?.includes("Map changed") && map) {
        map = await api("/" + map.id);
        render(false);
      }
      throw Error(data.error);
    }
    return data.result;
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      render(false);
      $("#map-scan-detail").textContent = e.message;
      message(e.message);
    } finally {
      busy = false;
    }
  }
  function fit() {
    const pts = map?.cells?.map((c) => [c[0] * 0.05, c[1] * 0.05]) || [];
    for (const a of map?.areas || [])
      for (const p of a.geometry) for (const r of p) pts.push(...r);
    if (!pts.length) {
      view = [-5, -5, 10, 10];
      return;
    }
    let x = Infinity,
      y = Infinity,
      X = -Infinity,
      Y = -Infinity;
    for (const raw of pts) {
      const c=Math.cos(angle),s=Math.sin(angle),p=[raw[0]*c+raw[1]*s,-raw[0]*s+raw[1]*c];
      x = Math.min(x, p[0]);
      X = Math.max(X, p[0]);
      y = Math.min(y, -p[1]);
      Y = Math.max(Y, -p[1]);
    }
    const side=Math.max(2,X-x+2,Y-y+2);
    view = [(x+X-side)/2,(y+Y-side)/2,side,side];
  }
  function render(inspector = true) {
    if (!alive) return;
    const nextAngle=(map?.displayAngle||0)*Math.PI/180;
    if(nextAngle!==angle){angle=nextAngle;fit();}
    svg.setAttribute("viewBox", view.join(" "));
    const cells = map?.cells || [];
    const robotPose=livePose || map?.scan?.pose;
    const measurements=!$("#map-vector").checked || $("#map-measurements").checked || !map?.vectors?.length;
    $("#map-plan-empty").hidden = !map || !!map?.cells?.length || !$("#map-vector").checked || !!map?.vectors?.length || !!map?.areas?.length;
    const fill = (test) =>
      cells
        .filter(test)
        .map(([x, y]) => `M${x * 0.05},${-(y + 1) * 0.05}h.05v.05h-.05Z`)
        .join("");
    svg.innerHTML = `<defs><pattern id="map-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#e3e7ea" stroke-width=".01"/></pattern></defs><rect x="-1000" y="-1000" width="2000" height="2000" fill="${$("#map-vector").checked ? "#fff" : "#eef0f2"}"/><rect x="-1000" y="-1000" width="2000" height="2000" fill="${$("#map-vector").checked ? "none" : "url(#map-grid)"}"/><path d="${fill((c) => c[2] < 0)}" fill="#fff"/><path d="${fill((c) => measurements && c[2] >= 2)}" fill="${$("#map-vector").checked ? "#c1c7cc" : "#56616a"}"/>${$("#map-vector").checked ? floorSurface(map) : ""}${robotPose ? `<g id="map-robot" visibility="${poseReceived && performance.now()-poseReceived<2000 ? "visible" : "hidden"}" transform="translate(${robotPose.x},${-robotPose.y}) rotate(${(-robotPose.theta * 180) / Math.PI})"><circle r=".16" fill="#3565d0" stroke="#f9fafb" stroke-width=".03"/><path d="M.24 0L.07 -.06V.06Z" fill="#3565d0"/></g>` : ""}`;
    if($("#map-vector").checked) svg.insertAdjacentHTML("beforeend",planDetails(map,$("#map-dimensions").checked));
    if(measurements && map?.scan?.trajectory?.length)svg.insertAdjacentHTML("beforeend",`<path d="M${map.scan.trajectory.map(p=>`${p.x},${-p.y}`).join("L")}" fill="none" stroke="#a4b8cc" stroke-width=".02"/>`);
    if (map?.scan?.path?.length)
      svg.insertAdjacentHTML(
        "beforeend",
        `<path d="M${map.scan.path.map(([x, y]) => `${x},${-y}`).join("L")}" fill="none" stroke="#6d92bd" stroke-width=".025" stroke-dasharray=".08 .06"/>`,
      );
    svg.insertAdjacentHTML("beforeend",boundaryMarkers(map)+stationMarker(map));
    const layer=document.createElementNS("http://www.w3.org/2000/svg","g");
    layer.id="map-content";layer.setAttribute("transform",`rotate(${angle*180/Math.PI})`);
    while(svg.firstChild)layer.append(svg.firstChild);svg.append(layer);
    if($("#map-vector").checked)svg.insertAdjacentHTML("beforeend",planDimensions(map,$("#map-dimensions").checked));
    $("#map-deep-legend").hidden=!map?.scan?.deep;
    if(map?.scan?.deep && map.scan.deepPass){
      const marks=map.scan.deepPass.targets.map(t=>`<circle class="map-inspection-target" cx="${t.point[0]}" cy="${-t.point[1]}" r=".065" fill="${t.state==='verified'?'#39816d':t.state==='checking' && map.scan.state==='scanning'?'#416abc':'#c17a36'}"><title>${t.state==='verified'?'Checked':t.state==='checking' && map.scan.state==='scanning'?'Checking':t.result==='approach_blocked'?'Approach blocked; needs another route':'Needs inspection'}</title></circle>`).join('');
      svg.insertAdjacentHTML("beforeend",`<g transform="rotate(${angle*180/Math.PI})">${marks}</g>`);
    }
    $("#map-station-status").textContent=map?.station?"Saved from verified docking position.":dock?.docked?"Dock detected; map position not yet verified.":"Not located on this map.";
    $("#map-return-onboard").disabled=!map?.station;
    $("#map-return").disabled=!map?.station || ["scanning","locating"].includes(map?.scan?.state);
    const safety = map?.scan?.sensors;
    $("#map-sensors").textContent = safety
      ? `Last scan · bumpers: ${safety.left ? "left pressed" : safety.right ? "right pressed" : "clear"} · Cliff/lift: ${safety.cliff_raw || safety.wheel_lift_raw ? "triggered" : "clear"}`
      : "";
    const state = map?.scan?.state || "idle";
    $("#map-scan-state").textContent =
      `${state[0].toUpperCase()+state.slice(1)}${cells.length ? ` · ${(cells.filter(c=>c[2]<0).length*.0025).toFixed(1)} m² mapped` : ""}`;
    $("#map-scan-detail").textContent = map?.scan?.error || map?.scan?.message || "Ready to scan.";
    if(map?.scan?.deep && map.scan.deepPass){const d=map.scan.deepPass;$("#map-scan-detail").textContent+=` · Deep pass: ${d.verified}/${d.total} sections checked, ${d.remaining} remaining`;}
    $(".map-scan-progress").dataset.state = state;
    $("#map-delete").disabled = !map;

    $("#map-hint").textContent = "Drag to pan · scroll to zoom";
    $("#map-return-onboard").onclick=()=>action(async()=>{if(!map)return;await stopDrive();const state=await api("/"+map.id+"/return-onboard",{});$("#engine-return-status").textContent=state.message;message("Return is running on Alfred. HQ can disconnect.");});
    $("#map-return").onclick=()=>action(async()=>{if(!map)return;await stopDrive();map=await api("/"+map.id+"/return",{});render();});
  document.querySelectorAll("[data-scan]").forEach((b) => {
      const a = b.dataset.scan;
      b.disabled =
        !map ||
        (a === "start"
          ? ["scanning", "locating", "paused"].includes(state) || !!map.cells.length
          : a === "resume" || a === "locate"
            ? !(
                ["paused", "interrupted", "finished"].includes(state) &&
                map.resumable
              )
            : a === "pause"
              ? !["scanning", "locating"].includes(state)
              : !["scanning", "locating", "paused", "interrupted"].includes(state));
    });
    if(inspector) {
      $("#map-name").value = map?.name || "";
      $("#map-rotation").value = map?.displayAngle ?? "";
    }
  }
  async function list(id) {
    const maps = await api();
    if (!alive) return;
    $("#map-select").innerHTML =
      '<option value="">Choose a map</option>' +
      maps
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)
        .join("");
    if (id) $("#map-select").value = id;
  }
  async function load(id) {
    if (!id) {
      map = null;
      render();
      return;
    }
    await stopDrive(); livePose = null; poseReceived = 0;
    const m = await api("/" + id);
    if (!alive) return;
    map = m;
    if (map.scan.mode) $("#scan-mode").value = map.scan.deep ? "deep" : map.scan.mode;
    syncManualControls();
    if (map.scan.minutes) $("#scan-minutes").value = map.scan.minutes;
    fit();
    render();
    localStorage.setItem("alfred-map", id);
  }
  async function edit(body) {
    if (!map) throw Error("Create or choose a map first.");
    const m = await api("/" + map.id + "/edit", {
      revision: map.revision,
      ...body,
    });
    if (!alive) return;
    map = m;
    render();
    message("Saved.");
    await list(map.id);
  }
  function syncManualControls() {
    const panel = $("#map-manual-controls");
    const hidden = $("#scan-mode").value !== "manual";
    if (!panel.hidden && hidden) stopDrive().catch(e=>message(e.message));
    panel.hidden = hidden;
  }
  $("#scan-mode").onchange = syncManualControls;
  $("#map-new").onclick = () =>
    action(async () => {
      const m = await api("", { name: "Untitled map" });
      await list(m.id);
      await load(m.id);
      $("#map-name").focus();
      $("#map-name").select();
    });
  $("#map-select").onchange = (e) => action(() => load(e.target.value));
  $("#map-set-rotation").onclick = () => action(() => edit({action:"rotation", angle:Number($("#map-rotation").value)}));
  $("#map-delete").onclick = () => action(async () => {
    if (!map || !confirm(`Delete “${map.name}” and its areas?`)) return;
    await api("/" + map.id, undefined, "DELETE");
    localStorage.removeItem("alfred-map");
    await list();
    await load("");
    message("Map deleted.");
  });
  $("#map-rename").onclick = () =>
    action(() => edit({ action: "rename-map", name: $("#map-name").value }));
  document.querySelectorAll("[data-scan]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          if (!map) return;
          await stopDrive();
          message("");
          $("#map-scan-detail").textContent = ["resume", "locate"].includes(b.dataset.scan) ? "Finding Alfred in the saved map…" : "Updating scan…";
          map = await api("/" + map.id + "/scan", {
            action: b.dataset.scan,
            station:b.dataset.station==="true",
            mode: $("#scan-mode").value,
            minutes: Number($("#scan-minutes").value),
          });
          if (b.dataset.scan === "start") fit();
          render();
          message("");
        })),
  );
  $("#map-fit").onclick = () => {
    fit();
    render(false);
  };
  $("#map-vector").onchange = () => render(false);
  $("#map-measurements").onchange = () => render(false);
  $("#map-dimensions").onchange = () => render(false);
  function point(e) {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      ($("#map-content") || svg).getScreenCTM().inverse(),
    );
    return [p.x, -p.y];
  }
  svg.onpointerdown = e => {
    if(e.button!==0) return;
    pointer={x:e.clientX,y:e.clientY,view:[...view]};
    svg.setPointerCapture(e.pointerId);
  };
  svg.onpointermove = e => {
    if(!pointer)return;
    const rect=svg.getBoundingClientRect(),scale=Math.max(view[2]/rect.width,view[3]/rect.height);
    view=[pointer.view[0]-(e.clientX-pointer.x)*scale,pointer.view[1]-(e.clientY-pointer.y)*scale,...pointer.view.slice(2)];
    svg.setAttribute("viewBox",view.join(" "));
  };
  svg.onpointerup = () => {pointer=null;};
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [x, y] = point(e),
        f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (view[2] * f < 0.5 || view[2] * f > 120) return;
      view = [
        x + (view[0] - x) * f,
        -y + (view[1] + y) * f,
        view[2] * f,
        view[3] * f,
      ];
      render(false);
    },
    { passive: false },
  );
  svg.onpointercancel = () => {
    pointer = null;
    render(false);
  };
  $("#map-emergency").onclick = () => {
    stopDrive(true).catch(e=>message(e.message));
    fetch("/api/maps/active/pause", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    })
      .then(() => {
        message("Movement stopped.");
        return map ? load(map.id) : null;
      })
      .catch((e) => message(e.message));
  };
  const key = (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === "Space") {
      e.preventDefault();
      $("#map-emergency").click();
    }
  };
  window.addEventListener("keydown", key);
  async function exportMap(png) {
    if (!map) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const scale = 1600 / Math.max(view[2], view[3]),
      width = Math.max(1, Math.round(view[2] * scale)),
      height = Math.max(1, Math.round(view[3] * scale));
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
      type: "image/svg+xml",
    });
    let output = blob;
    if (png) {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        output = await new Promise((r) => c.toBlob(r, "image/png"));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const url = URL.createObjectURL(output),
      a = document.createElement("a");
    a.href = url;
    a.download = map.name + "." + (png ? "png" : "svg");
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("#map-svg-export").onclick = () => action(() => exportMap(false));
  $("#map-png-export").onclick = () => action(() => exportMap(true));
  async function pollPosition() {
    const id = map?.id;
    if (id) {
      try {
        const r = await fetch(`/api/maps/${id}/position`, {signal:AbortSignal.timeout(2000),cache:"no-store"});
        const value = await r.json();
        if (!r.ok || !value.ok) throw Error(value.error || "Position unavailable");
        if (!alive || map?.id !== id) throw Error("View changed");
        const state = value.result;
        if (state.pose) livePose = state.pose;
        poseReceived = state.pose ? performance.now() : 0;
        $("#map-position-status").textContent = state.pose ? "Position: live" : `Position: ${state.message}`;
        let marker = $("#map-robot");
        if (livePose && !marker) {
          $("#map-content")?.insertAdjacentHTML("beforeend", '<g id="map-robot"><circle r=".16" fill="#3565d0" stroke="#f9fafb" stroke-width=".03"/><path d="M.24 0L.07 -.06V.06Z" fill="#3565d0"/></g>');
          marker = $("#map-robot");
        }
        if (marker) {
          marker.setAttribute("visibility",state.pose ? "visible" : "hidden");
          if (livePose) marker.setAttribute("transform",`translate(${livePose.x},${-livePose.y}) rotate(${-livePose.theta*180/Math.PI})`);
        }
      } catch {
        if (alive && map?.id === id) {
          poseReceived = 0;
          $("#map-position-status").textContent = "Position: connection unavailable";
          if ($("#map-robot")) $("#map-robot").setAttribute("visibility","hidden");
        }
      }
    }
    if (alive) poseTimer = setTimeout(pollPosition, 150);
  }
  async function poll() {
    try {
      try {const state=await api("/engine-return");onboard=state;if(alive)$("#engine-return-status").textContent=`Onboard: ${state.message}`;}catch(e){if(alive)$("#engine-return-status").textContent=`Onboard status unavailable: ${e.message}`;}
      if(Date.now()-dockCheckedAt>5000){
        dockCheckedAt=Date.now();
        try{const r=await fetch('/api/bots/alfred/station',{signal:AbortSignal.timeout(4000)});const value=await r.json();dock=value.ok?value.result:null;}catch{dock=null;}
        if(alive)render(false);
      }
      if (map && !busy && ["scanning", "locating", "paused"].includes(map.scan.state)) {
        const id = map.id,
          m = await api("/" + id);
        if (alive && map?.id === id && !busy) {
          map.cells = m.cells;
          map.vectors = m.vectors;
          map.structure = m.structure;
          map.scan = m.scan;
          map.station = m.station;
          map.stationDetection = m.stationDetection;
          map.resumable = m.resumable;
          render(false);
        }
      }
    } catch (e) {
      message(e.message);
    }
    if (alive) timer = setTimeout(poll, 1000);
  }
  action(async () => {
    await list();
    const id = localStorage.getItem("alfred-map");
    if (id && [...$("#map-select").options].some((o) => o.value === id)) {
      $("#map-select").value = id;
      await load(id);
    } else render();
  }).then(()=>{poll();pollPosition();});
  return () => {
    alive = false;
    clearTimeout(timer);
    clearTimeout(poseTimer);
    stopDrive().catch(()=>{});
    window.removeEventListener("keydown", key);
  };
}
