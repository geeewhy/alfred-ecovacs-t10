import {floorSurface, roomLabel,planDetails,planDimensions} from "./floor-plan.js";
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function mapsPage() {
  return `<section class="maps-page"><header class="maps-heading"><div><span class="eyebrow">ALFRED / SPATIAL</span><h1>Maps</h1></div><div><select id="map-select" aria-label="Saved map"></select><button id="map-new">New map</button></div></header><div class="map-toolbar"><select id="scan-mode" aria-label="Scan mode"><option value="explore">Explore automatically</option><option value="manual">Manual capture</option></select><label class="scan-duration"><input id="scan-minutes" type="number" value="10" min="1" max="60" aria-label="Maximum scan minutes"> min</label><button data-scan="start">Start scan</button><button data-scan="pause">Pause</button><button data-scan="resume">Resume</button><button data-scan="locate">Locate Alfred</button><button data-scan="finish">Finish scan</button><button id="map-emergency">Stop movement</button></div><div class="map-scan-progress" role="status" aria-live="polite"><strong id="map-scan-state">No scan</strong><span id="map-scan-detail">Create or choose a map.</span><small id="map-sensors"></small></div><div class="map-workspace"><div class="map-stage"><div class="map-tools"><button data-tool="select">Select / pan</button><button data-tool="draw">Draw area</button><button data-tool="split">Split</button><button data-tool="vertices">Edit corners</button><button data-tool="door">Door</button><button data-tool="window">Window</button><button data-tool="erase-opening">Erase opening</button><button id="map-close">Finish polygon</button><button id="map-cancel">Cancel</button><button id="map-undo">Undo</button><button id="map-redo">Redo</button><button id="map-fit">Fit</button><label><input id="map-vector" type="checkbox" checked> Floor plan</label><label><input id="map-measurements" type="checkbox"> Measurements</label><label><input id="map-dimensions" type="checkbox" checked> Dimensions</label></div><svg id="map-svg" role="img" aria-label="Floor plan and area editor" tabindex="0" viewBox="-5 -5 10 10"></svg><div id="map-plan-empty" class="map-plan-empty" hidden>Building the floor plan from the live scan.</div><div class="map-legend" aria-label="Map legend"><span class="map-key-wall">Likely walls</span><span class="map-key-obstacle">Obstacles</span><span class="map-key-unknown">Unscanned</span></div><div id="map-hint">Create a map to begin.</div></div><aside class="map-inspector"><label>Map name<input id="map-name" maxlength="80"></label><button id="map-rename">Save name</button><h2>Areas</h2><p class="map-muted">Select an area, or use Shift to select several.</p><div id="map-areas"></div><label>Area name<input id="area-name" maxlength="80" placeholder="e.g. Living room"></label><button id="area-rename">Rename area</button><button id="area-reshape">Redraw boundary</button><button id="area-merge">Merge selected</button><button id="area-delete">Delete selected</button><hr><button id="map-svg-export">Export SVG</button><button id="map-png-export">Export PNG</button><hr><label>Plan rotation<input id="map-rotation" type="number" step="1" placeholder="Automatic wall alignment"></label><button id="map-set-rotation">Apply rotation</button><hr><button id="map-delete">Delete map</button></aside></div><p id="map-message" role="status" aria-live="polite"></p></section>`;
}
export function mountMaps() {
  let alive = true,
    map = null,
    selected = new Set(),
    tool = "select",
    draft = [],
    reshape = null,
    view = [-5, -5, 10, 10],
    timer,
    angle = 0,
    busy = false,
    pointer = null,
    vertexGeometry = null;
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
  const path = (g) =>
    g
      .map((p) =>
        p
          .map((r) => "M" + r.map(([x, y]) => `${x},${-y}`).join("L") + "Z")
          .join(""),
      )
      .join("");
  const color = (i) =>
    ["#6878b6", "#438c7f", "#b58952", "#9c719a", "#538aa4"][i % 5];
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
    const measurements=!$("#map-vector").checked || $("#map-measurements").checked || !map?.vectors?.length;
    $("#map-plan-empty").hidden = !map || !!map?.cells?.length || !$("#map-vector").checked || !!map?.vectors?.length || !!map?.areas?.length;
    const fill = (test) =>
      cells
        .filter(test)
        .map(([x, y]) => `M${x * 0.05},${-(y + 1) * 0.05}h.05v.05h-.05Z`)
        .join("");
    svg.innerHTML = `<defs><pattern id="map-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#e3e7ea" stroke-width=".01"/></pattern></defs><rect x="-1000" y="-1000" width="2000" height="2000" fill="${$("#map-vector").checked ? "#fff" : "#eef0f2"}"/><rect x="-1000" y="-1000" width="2000" height="2000" fill="${$("#map-vector").checked ? "none" : "url(#map-grid)"}"/><path d="${fill((c) => c[2] < 0)}" fill="#fff"/><path d="${fill((c) => measurements && c[2] >= 2)}" fill="${$("#map-vector").checked ? "#c1c7cc" : "#56616a"}"/>${$("#map-vector").checked ? floorSurface(map) : ""}${$("#map-vector").checked ? `<path d="${(map?.structure?.floor?.geometry?.length ? [] : map?.vectors || []).map(([a, b]) => `M${a[0]},${-a[1]}L${b[0]},${-b[1]}`).join("")}" fill="none" stroke="#171717" stroke-width=".1" stroke-linecap="square"/>` : ""}${(map?.areas || []).map((a, i) => `<path data-area="${a.id}" d="${path(selected.has(a.id) && vertexGeometry ? vertexGeometry : a.geometry)}" fill="${color(i)}" fill-opacity="${selected.has(a.id) ? 0.12 : 0.015}" fill-rule="evenodd" stroke="${color(i)}" stroke-width="${selected.has(a.id) ? 0.045 : 0.025}"/>${roomLabel(a,angle*180/Math.PI)}`).join("")}${draft.length ? `<path d="M${draft.map(([x, y]) => `${x},${-y}`).join("L")}" fill="none" stroke="#4268d2" stroke-width=".03"/>${draft.map(([x, y]) => `<circle cx="${x}" cy="${-y}" r=".045" fill="#4268d2"/>`).join("")}` : ""}${map?.scan?.pose ? `<g transform="translate(${map.scan.pose.x},${-map.scan.pose.y}) rotate(${(-map.scan.pose.theta * 180) / Math.PI})"><circle r=".16" fill="#3565d0" stroke="#f9fafb" stroke-width=".03"/><path d="M.24 0L.07 -.06V.06Z" fill="#3565d0"/></g>` : ""}`;
    if($("#map-vector").checked) svg.insertAdjacentHTML("beforeend",planDetails(map,$("#map-dimensions").checked));
    $("#map-undo").disabled = !map?.canUndo;
    $("#map-redo").disabled = !map?.canRedo;
    if(measurements && map?.scan?.trajectory?.length)svg.insertAdjacentHTML("beforeend",`<path d="M${map.scan.trajectory.map(p=>`${p.x},${-p.y}`).join("L")}" fill="none" stroke="#a4b8cc" stroke-width=".02"/>`);
    if (map?.scan?.path?.length)
      svg.insertAdjacentHTML(
        "beforeend",
        `<path d="M${map.scan.path.map(([x, y]) => `${x},${-y}`).join("L")}" fill="none" stroke="#6d92bd" stroke-width=".025" stroke-dasharray=".08 .06"/>`,
      );
    if (tool === "vertices" && selected.size === 1) {
      const a = map.areas.find((a) => selected.has(a.id));
      const geometry = vertexGeometry || a?.geometry;
      if (geometry)
        geometry.forEach((p, pi) =>
          p.forEach((r, ri) =>
            r
              .slice(0, -1)
              .forEach(([x, y], vi) =>
                svg.insertAdjacentHTML(
                  "beforeend",
                  `<circle data-vertex="${pi},${ri},${vi}" cx="${x}" cy="${-y}" r=".065" fill="#fafbfe" stroke="#4268d2" stroke-width=".025"/>`,
                ),
              ),
          ),
        );
    }
    const layer=document.createElementNS("http://www.w3.org/2000/svg","g");
    layer.id="map-content";layer.setAttribute("transform",`rotate(${angle*180/Math.PI})`);
    while(svg.firstChild)layer.append(svg.firstChild);svg.append(layer);
    if($("#map-vector").checked)svg.insertAdjacentHTML("beforeend",planDimensions(map,$("#map-dimensions").checked));
    const safety = map?.scan?.sensors;
    $("#map-sensors").textContent = safety
      ? `Last scan · bumpers: ${safety.left ? "left pressed" : safety.right ? "right pressed" : "clear"} · Cliff/lift: ${safety.cliff_raw || safety.wheel_lift_raw ? "triggered" : "clear"}`
      : "";
    const state = map?.scan?.state || "idle";
    $("#map-scan-state").textContent =
      `${state[0].toUpperCase()+state.slice(1)}${cells.length ? ` · ${(cells.filter(c=>c[2]<0).length*.0025).toFixed(1)} m² mapped` : ""}`;
    $("#map-scan-detail").textContent = map?.scan?.error || map?.scan?.message || "Ready to scan.";
    $(".map-scan-progress").dataset.state = state;
    $("#map-delete").disabled = !map;

    $("#map-hint").textContent =
      (["door","window"].includes(tool) ? "Click the two ends of the opening. For a door, start at the hinge." : tool === "erase-opening" ? "Click an opening to remove it." : tool === "draw"
        ? "Click polygon corners. Enter finishes; Escape cancels."
        : tool === "split"
          ? "Click two points across the selected area."
          : tool === "vertices"
            ? "Drag a corner to edit the selected area."
            : "Drag to pan · scroll to zoom · 1 m grid. Choose automatic exploration or manual capture.");
    document.querySelectorAll("[data-scan]").forEach((b) => {
      const a = b.dataset.scan;
      b.disabled =
        !map ||
        (a === "start"
          ? state === "scanning" || state === "paused" || !!map.cells.length
          : a === "resume" || a === "locate"
            ? !(
                ["paused", "interrupted", "finished"].includes(state) &&
                map.resumable
              )
            : a === "pause"
              ? state !== "scanning"
              : !["scanning", "paused", "interrupted"].includes(state));
    });
    document
      .querySelectorAll("[data-tool]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    if (inspector) {
      $("#map-name").value = map?.name || "";
      $("#map-rotation").value = map?.displayAngle ?? "";
      $("#map-areas").innerHTML =
        (map?.areas || [])
          .map(
            (a, i) =>
              `<button class="map-area ${selected.has(a.id) ? "active" : ""}" data-id="${a.id}"><span style="color:${color(i)}">●</span> ${esc(a.name)} <small>${a.area.toFixed(1)} m²</small></button>`,
          )
          .join("") ||
        '<p class="map-muted">Draw your first area on the map.</p>';
      $("#map-areas")
        .querySelectorAll("button")
        .forEach((b) => (b.onclick = (e) => choose(b.dataset.id, e.shiftKey)));
      $("#area-name").value =
        selected.size === 1
          ? map.areas.find((a) => selected.has(a.id))?.name || ""
          : "";
    }
  }
  function choose(id, multi) {
    if (!multi) selected.clear();
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
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
    const m = await api("/" + id);
    if (!alive) return;
    map = m;
    if (map.scan.mode) $("#scan-mode").value = map.scan.mode;
    if (map.scan.minutes) $("#scan-minutes").value = map.scan.minutes;
    selected.clear();
    draft = [];
    fit();
    render();
    localStorage.setItem("alfred-map", id);
  }
  async function edit(body) {
    if (!map) throw Error("Create or choose a map first.");
    const m = await api("/" + map.id + "/edit", {
      revision: map.revision,
      ids: [...selected],
      ...body,
    });
    if (!alive) return;
    map = m;
    selected = new Set(
      [...selected].filter((id) => map.areas.some((a) => a.id === id)),
    );
    draft = [];
    tool = "select";
    reshape = null;
    render();
    message("Saved.");
    await list(map.id);
  }
  async function finish() {
    if (tool !== "draw") return;
    await edit({
      action: reshape ? "reshape" : "draw",
      ids: reshape ? [reshape] : [...selected],
      points: draft,
      name: $("#area-name").value || undefined,
    });
  }
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
    selected.clear();
    draft = [];
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
          message("");
          $("#map-scan-detail").textContent = ["resume", "locate"].includes(b.dataset.scan) ? "Finding Alfred in the saved map…" : "Updating scan…";
          map = await api("/" + map.id + "/scan", {
            action: b.dataset.scan,
            mode: $("#scan-mode").value,
            minutes: Number($("#scan-minutes").value),
          });
          if (b.dataset.scan === "start") fit();
          render();
          message("");
        })),
  );
  document.querySelectorAll("[data-tool]").forEach(
    (b) =>
      (b.onclick = () => {
        if (
          ["split", "vertices"].includes(b.dataset.tool) &&
          selected.size !== 1
        ) {
          message("Select one area first.");
          return;
        }
        tool = b.dataset.tool;
        draft = [];
        reshape = null;
        vertexGeometry = null;
        render(false);
      }),
  );
  $("#map-undo").disabled = !map?.canUndo;
  $("#map-redo").disabled = !map?.canRedo;
  $("#map-undo").onclick = () => action(() => edit({ action: "undo" }));
  $("#map-redo").onclick = () => action(() => edit({ action: "redo" }));
  $("#map-close").onclick = () => action(finish);
  $("#map-cancel").onclick = () => {
    draft = [];
    tool = "select";
    reshape = null;
    render(false);
  };
  $("#map-fit").onclick = () => {
    fit();
    render(false);
  };
  $("#map-vector").onchange = () => render(false);
  $("#map-measurements").onchange = () => render(false);
  $("#map-dimensions").onchange = () => render(false);
  $("#area-rename").onclick = () =>
    action(() => edit({ action: "rename", name: $("#area-name").value }));
  $("#area-delete").onclick = () => action(() => edit({ action: "delete" }));
  $("#area-merge").onclick = () =>
    action(() =>
      edit({ action: "merge", name: $("#area-name").value || undefined }),
    );
  $("#area-reshape").onclick = () => {
    if (selected.size !== 1) return message("Select one area to redraw.");
    reshape = [...selected][0];
    tool = "draw";
    draft = [];
    render(false);
  };
  function point(e) {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      ($("#map-content") || svg).getScreenCTM().inverse(),
    );
    return [p.x, -p.y];
  }
  svg.onpointerdown = (e) => {
    if (e.button !== 0 || busy) return;
    pointer = {
      x: e.clientX,
      y: e.clientY,
      p: point(e),
      view: [...view],
      id: e.target.dataset.area,
      feature: e.target.closest("[data-feature]")?.dataset.feature,
      vertex: e.target.dataset.vertex,
    };
    svg.setPointerCapture(e.pointerId);
  };
  svg.onpointermove = (e) => {
    if (pointer?.vertex && tool === "vertices") {
      const a = map.areas.find((a) => selected.has(a.id));
      vertexGeometry ||= structuredClone(a.geometry);
      const [pi, ri, vi] = pointer.vertex.split(",").map(Number),
        r = vertexGeometry[pi][ri];
      r[vi] = point(e);
      if (vi === 0) r[r.length - 1] = [...r[0]];
      render(false);
      return;
    }
    if (!pointer || tool !== "select") return;
    const rect = svg.getBoundingClientRect(),
      scale = Math.max(view[2] / rect.width, view[3] / rect.height);
    view = [
      pointer.view[0] - (e.clientX - pointer.x) * scale,
      pointer.view[1] - (e.clientY - pointer.y) * scale,
      ...pointer.view.slice(2),
    ];
    render(false);
  };
  svg.onpointerup = (e) => {
    if (!pointer) return;
    const p = pointer;
    pointer = null;
    if (p.vertex && vertexGeometry) {
      const geometry = vertexGeometry;
      vertexGeometry = null;
      action(() => edit({ action: "reshape", geometry }));
      return;
    }
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
    if (tool === "select") {
      if (p.id) choose(p.id, e.shiftKey);
      else {
        selected.clear();
        render();
      }
    } else if(map && tool === "erase-opening" && p.feature) {
      action(()=>edit({action:"delete-feature",id:p.feature}));
    } else if (map && ["draw", "split", "door", "window"].includes(tool)) {
      draft.push(point(e));
      render(false);
      if(["door","window"].includes(tool) && draft.length===2)action(()=>edit({action:"feature",kind:tool,points:draft}));
      if (tool === "split" && draft.length === 2)
        action(() => edit({ action: "split", points: draft }));
    }
  };
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
    vertexGeometry = null;
    render(false);
  };
  $("#map-emergency").onclick = () => {
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
    if (e.key === "Enter") {
      e.preventDefault();
      action(finish);
    }
    if (e.key === "Escape") $("#map-cancel").click();
    if (e.key === "Backspace" && draft.length) {
      e.preventDefault();
      draft.pop();
      render(false);
    }
  };
  window.addEventListener("keydown", key);
  async function exportMap(png) {
    if (!map) return;
    const clone = svg.cloneNode(true);
    clone.querySelectorAll("[data-vertex]").forEach((n) => n.remove());
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
  async function poll() {
    try {
      if (map && !busy && ["scanning", "paused"].includes(map.scan.state)) {
        const id = map.id,
          m = await api("/" + id);
        if (alive && map?.id === id && !busy) {
          map.cells = m.cells;
          map.vectors = m.vectors;
          map.structure = m.structure;
          map.scan = m.scan;
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
  }).then(poll);
  return () => {
    alive = false;
    clearTimeout(timer);
    window.removeEventListener("keydown", key);
  };
}
