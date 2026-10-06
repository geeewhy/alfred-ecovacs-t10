import {sectionNames, sectionGeometry, normalizeSectionName, sectionTarget} from './sections.mjs';
import { livePosition } from "./live-position.mjs";
import { stationObservation, retainStation } from "./station.mjs";
import { NativeScanner, GraphScanner, NavigationClient } from "./native-scanner.mjs";
import { scanAge } from "./freshness.mjs";
import { Worker } from "node:worker_threads";
import { align } from "./scanner.mjs";
import { localPoints } from "./localization.mjs";
import { diagnosticState } from "../infra/diagnostics.mjs";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { polygon, split, merge, area, validateGeometry } from "./geometry.mjs";
import { supportedWalls, structuralPlan } from "./walls.mjs";
import { Scanner, outlines } from "./scanner.mjs";
import { Explorer } from "./explorer.mjs";
const directory = fileURLToPath(
  new URL("../../../artifacts/hq/maps/", import.meta.url),
);
const name = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 80)
    throw Error("Name must be 1–80 characters.");
  return value.trim();
};
export class MapService {
  constructor(engine, dir = directory) {
    this.engine = engine;
    this.dir = dir;
    this.queue = Promise.resolve();
    this.active = null;
    this.navigation = new NavigationClient();
    this.timer = null;
    this.epoch = 0;
    this.native = typeof engine.nativeMapping === "function" ? {call:async()=>{
      const status=await engine.nativeMapping("status"),bytes=status.reports?.["/task/WorkState"]?.bytes;
      if(!bytes || bytes.length<3)throw Error("Native task status unavailable");
      return {...status,work:{type:bytes[0],subtype:bytes[1],state:bytes[2]}};
    }} : null;
  }
  serial(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid map ID");
    return `${this.dir}/${id}.json`;
  }
  async load(id) {
    return JSON.parse(await readFile(this.path(id), "utf8"));
  }
  async save(map) {
    await mkdir(this.dir, { recursive: true });
    const path = this.path(map.id);
    map.updatedAt = Date.now();
    await writeFile(path + ".tmp", JSON.stringify(map));
    await rename(path + ".tmp", path);
    return map;
  }
  async list() {
    await mkdir(this.dir, { recursive: true });
    const files = await readdir(this.dir);
    return Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const m = await this.load(f.slice(0, -5));
          return {
            id: m.id,
            name: m.name,
            updatedAt: m.updatedAt,
            areas: m.areas.length,
            scan: this.active?.id === m.id ? this.active.status : m.scan,
          };
        }),
    );
  }
  async get(id) {
    const m = await this.load(id);
    if (this.active?.id === id) {
      if(this.active.station)m.station=retainStation(m.station,this.active.station,this.active.stationRequested);
      m.scan = { ...this.active.status };
      m.cells = this.active.scanner.grid();
    }
    const { undo, redo, checkpoint, exploration, ...visible } = m;
    return {
      ...visible,
      canUndo: !!undo?.length,
      canRedo: !!redo?.length,
      resumable: !!checkpoint,
      vectors: m.structure?.walls.filter(w=>w.observations>=2).map(w=>w.points) || (checkpoint?.backend==="slam_toolbox" ? [] : supportedWalls(m.cells, this.active?.id===id ? this.active.scanner.keyframes : checkpoint?.keyframes)),
    };
  }
  async refreshStructure(id) {
    const snapshot = await this.navigation.call("structure");
    if(snapshot?.map_id !== id || !snapshot.grid || !snapshot.keyframes?.length) throw Error("No corrected scan evidence available for this map");
    return this.serial(async()=>{
      const m=await this.load(id),scanner=new GraphScanner(m.checkpoint);
      scanner.acceptStructure(snapshot);
      const evidence=scanner.structuralSnapshot;
      m.structure=structuralPlan(evidence.cells,{...m.structure,sequence:null},snapshot.sequence,snapshot.keyframes);
      await this.save(m);
      return {walls:m.structure.walls.length};
    });
  }
  async position(id) {
    this.path(id);
    // Coalesce viewers, keep high-rate marker reads out of map persistence and
    // autonomous heartbeat/ownership paths. Both calls are read-only.
    if (!this.positionTask || performance.now() - this.positionAt > 120) {
      this.positionAt = performance.now();
      this.positionTask = Promise.allSettled([this.engine.onboardReturn(), this.engine.localization()]);
    }
    const [engine, nav] = await this.positionTask;
    return livePosition(id, engine.status==='fulfilled'?engine.value:null, null, nav.status==='fulfilled'?nav.value:null);
  }
  async remove(id) {
    this.path(id);
    // Stop immediately; queued work must observe the new epoch before driving.
    this.epoch++;
    if (this.active?.id === id && ["scanning","locating"].includes(this.active.status.state)) {
      this.active.status.state = "paused";
      clearTimeout(this.timer);
      try { await this.navigation.call("pause"); } finally { await this.engine.stop(); }
      if (this.active.scanner?.backend === "native") await this.engine.nativeMapping("pause");
    }
    return this.serial(async () => {
      const removed=await this.load(id);
      if(removed.checkpoint?.backend==="slam_toolbox")await this.navigation.call("mapping/delete",{id});
      await mkdir(`${this.dir}/deleted`, { recursive: true });
      await rename(this.path(id), `${this.dir}/deleted/${id}.json`);
      if (this.active?.id === id) this.active = null;
      return { id, deleted: true };
    });
  }
  create(body) {
    return this.serial(() =>
      this.save({
        id: randomUUID(),
        name: name(body.name || "Untitled map"),
        revision: 0,
        areas: [],
        cells: [],
        scan: { state: "idle" },
        resolution: 0.05,
      }),
    );
  }
  edit(id, body) {
    return this.serial(async () => {
      const m = await this.load(id);
      if (body.revision !== m.revision)
        throw Error("Map changed. Reload before editing.");
      const previous = { name: m.name, northAngle: m.northAngle, displayAngle:m.displayAngle, features: structuredClone(m.features || []), areas: structuredClone(m.areas) };
      m.undo ||= [];
      m.redo ||= [];
      const selected = m.areas.filter((a) => (body.ids || []).includes(a.id));
      const make = (geometry, label) => ({
        id: randomUUID(),
        name: name(label),
        geometry,
        area: area(geometry),
      });
      switch (body.action) {
        case "undo":
        case "redo": {
          const from = body.action === "undo" ? m.undo : m.redo,
            to = body.action === "undo" ? m.redo : m.undo;
          const state = from.pop();
          if (!state) throw Error("Nothing to " + body.action);
          to.push(previous);
          m.name = state.name;
          m.northAngle = state.northAngle;
          m.displayAngle = state.displayAngle;
          m.features = state.features || [];
          m.areas = state.areas;
          break;
        }
        case "feature": {
          if(!["door","window"].includes(body.kind) || !Array.isArray(body.points) || body.points.length!==2 || body.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||Math.abs(n)>1000)))throw Error("Choose two valid opening endpoints.");
          const [a,b]=body.points,width=Math.hypot(a[0]-b[0],a[1]-b[1]);
          if(width<.15||width>5)throw Error("Opening width must be between 0.15 and 5 m.");
          m.features ||= [];
          if(m.features.length>=200)throw Error("Maximum 200 openings per map.");
          m.features.push({id:randomUUID(),kind:body.kind,points:body.points});
          break;
        }
        case "delete-feature":
          m.features=(m.features||[]).filter(f=>f.id!==body.id);
          break;
        case "rotation":
          if(!Number.isFinite(body.angle))throw Error("Enter a rotation in degrees.");
          m.displayAngle=((body.angle%360)+360)%360;
          m.displayAngleManual=true;
          break;
        case "north":
          if(!Number.isFinite(body.angle))throw Error("Enter a north direction in degrees.");
          m.northAngle=((body.angle%360)+360)%360;
          break;
        case "rename-map":
          m.name = name(body.name);
          break;
        case "save-section": {
          const existing=body.id ? m.areas.find(a=>a.id===body.id) : null;
          if(body.id && !existing)throw Error("This section no longer exists. Reload the map.");
          const names=sectionNames(body.name,body.aliases||[],m.areas.filter(a=>a!==existing));
          const geometry=body.points ? sectionGeometry(m,body.points) : existing?.geometry;
          if(!geometry)throw Error("Select a section on the map first.");
          const section={...(existing||{id:randomUUID()}),...names,geometry,area:area(geometry)};
          if(existing)m.areas[m.areas.indexOf(existing)]=section;else m.areas.push(section);
          break;
        }
        case "draw":
          m.areas.push(
            make(
              polygon(body.points),
              body.name || `Area ${m.areas.length + 1}`,
            ),
          );
          break;
        case "rename":
          if (selected.length !== 1) throw Error("Select one area.");
          selected[0].name = name(body.name);
          break;
        case "reshape":
          if (selected.length !== 1) throw Error("Select one area.");
          selected[0].geometry = body.geometry
            ? validateGeometry(body.geometry)
            : polygon(body.points);
          selected[0].area = area(selected[0].geometry);
          break;
        case "delete":
          if (!selected.length) throw Error("Select an area.");
          m.areas = m.areas.filter((a) => !selected.includes(a));
          break;
        case "merge":
          if (selected.length < 2) throw Error("Select at least two areas.");
          m.areas = m.areas.filter((a) => !selected.includes(a));
          m.areas.push(
            make(
              merge(selected.map((a) => a.geometry)),
              body.name || selected[0].name,
            ),
          );
          break;
        case "split":
          if (selected.length !== 1) throw Error("Select one area.");
          const parts = split(
            selected[0].geometry,
            body.points?.[0],
            body.points?.[1],
          );
          m.areas = m.areas.filter((a) => a !== selected[0]);
          parts.forEach((g, i) =>
            m.areas.push(make(g, `${selected[0].name.slice(0, 76)} ${i + 1}`)),
          );
          break;
        default:
          throw Error("Unknown map edit");
      }
      if (!["undo", "redo"].includes(body.action)) {
        m.undo.push(previous);
        m.undo = m.undo.slice(-20);
        m.redo = [];
      }
      if (m.areas.length > 200) throw Error("Maximum 200 areas per map.");
      m.revision++;
      await this.save(m);
      return this.get(id);
    });
  }

  async sectionCatalog() {
    const maps=await this.list();
    return Promise.all(maps.map(async ({id,name})=>{
      const map=await this.load(id);
      return {mapId:id,mapName:name,revision:map.revision,sections:map.areas.map(a=>({id:a.id,name:a.name,aliases:a.aliases||[],area:a.area}))};
    }));
  }
  async resolveSection(query,mapId) {
    if(typeof query!=="string" || !normalizeSectionName(query) || query.length>80)throw Error("Provide a section name.");
    if(mapId)this.path(mapId);
    const catalog=await this.sectionCatalog(),key=normalizeSectionName(query),matches=[];
    for(const m of catalog)if(!mapId||m.mapId===mapId)for(const s of m.sections)if([s.name,...s.aliases].some(n=>normalizeSectionName(n)===key))matches.push({...s,mapId:m.mapId,mapName:m.mapName,revision:m.revision});
    if(matches.length!==1)return {status:matches.length?'ambiguous':'not-found',matches};
    const match=matches[0],map=await this.load(match.mapId),section=map.areas.find(s=>s.id===match.id);
    // A concurrent rename/removal must never resolve stale labels to a destination.
    if(map.revision!==match.revision || !section)return {status:'changed',matches:[]};
    return {status:'resolved',section:{...match,geometry:section.geometry,target:sectionTarget(map,section)}};
  }

  summary() {
    return this.active ? { id: this.active.id, ...this.active.status } : null;
  }
  async followCat(id) {
    const intent=++this.epoch;
    const map=await this.load(id),grid=map.checkpoint?.nativeGrid;
    if(!grid?.cells?.length)throw Error("A saved map is required for cat search");
    if((await this.engine.onboardReturn()).active)throw Error("Stop the active navigation task first");
    if(this.epoch!==intent)throw Error("Cat search preparation cancelled");
    await this.pauseActive();
    const epoch=this.epoch;
    await this.engine.ensureMappingLidar();
    if(this.epoch!==epoch)throw Error("Cat search preparation cancelled");
    await this.engine.localization("map",{map_id:id,revision:`hq-${map.revision}`,grid});
    if(this.epoch!==epoch)throw Error("Cat search preparation cancelled");
    await this.engine.catFollow("start",{map_id:id});
    return this.engine.catFollow();
  }
  async navigateTo(id,pose) {
    if(!pose || !["x","y","theta"].every(k=>Number.isFinite(pose[k])))throw Error("Choose a finite map destination and heading");
    const intent=++this.epoch;
    const map=await this.load(id),grid=map.checkpoint?.nativeGrid;
    if(!grid?.cells?.length)throw Error("A saved map is required");
    if(this.epoch!==intent)throw Error("Navigation preparation cancelled");
    await this.pauseActive();
    const epoch=this.epoch;
    await this.engine.ensureMappingLidar();
    if(this.epoch!==epoch)throw Error("Navigation preparation cancelled");
    await this.engine.localization("map",{map_id:id,revision:`hq-${map.revision}`,grid});
    if(this.epoch!==epoch)throw Error("Navigation preparation cancelled");
    await this.engine.navigate("start",{map_id:id,pose});
    return this.engine.navigate();
  }
  async returnOnboard(id) {
    const intent=++this.epoch;
    const running=await this.engine.onboardReturn();
    if(running.active){if(running.goal)throw Error("Stop point navigation before starting return");if(running.map_id!==id)throw Error("Engine is returning on another map");return running;}
    const map=await this.load(id),grid=map.checkpoint?.nativeGrid;
    if(map.station?.source!=="docked-robot-pose" || !grid?.cells?.length)throw Error("A saved map and verified station are required");
    const enclosure=JSON.parse(await readFile(new URL("../../../mapping/calibration/dock-enclosure.json",import.meta.url),"utf8")).points;
    if(this.epoch!==intent)throw Error("Onboard return preparation cancelled");
    await this.pauseActive();
    const epoch=this.epoch;
    await this.engine.ensureMappingLidar();
    if(this.epoch!==epoch)throw Error("Onboard return preparation cancelled");
    // Stop a running companion before handing ownership to the robot. Its
    // availability is not required when no HQ motion operation exists.
    const {x,y,theta}=map.station;
    await this.engine.onboardReturn("config",{map_id:id,width:grid.width,height:grid.height,resolution:grid.resolution,origin:grid.origin,cells:grid.cells,station:{x,y,theta},enclosure});
    if(this.epoch!==epoch)throw Error("Onboard return preparation cancelled");
    await this.engine.onboardReturn("start");
    return this.engine.onboardReturn();
  }
  async returnToStation(id) {
    const map=await this.load(id);
    if(!map.station || map.station.source!=="docked-robot-pose")throw Error("Locate the station on this map first.");
    if((await this.engine.dockStatus()).docked)throw Error("Alfred is already docked.");
    // Explicit custom return replaces only the native return job, never cleaning.
    const native=await this.engine.nativeMapping("status"),work=native.reports?.["/task/WorkState"]?.bytes;
    if(work?.[2]!==0){
      if(work?.[0]!==5)throw Error("End the current firmware task before custom return.");
      await this.engine.stopNativeReturn();
    }
    await this.pauseActive();
    await this.scan(id,"resume",{mode:"manual",allowMotion:true});
    const active=this.active;
    if(!active || active.id!==id || !["locating","scanning"].includes(active.status.state))throw Error("Map preparation did not start.");
    active.returnPending=true;active.returnStation=map.station;active.returnStartedAt=Date.now();
    active.status.customReturn={state:"preparing",message:"Finding Alfred before returning to the station"};
    if(active.status.state==="scanning")await this.startCustomReturn(active);
    return this.get(id);
  }
  async startCustomReturn(active) {
    const epoch=this.epoch;
    await this.engine.connect?.();
    if(this.active!==active || this.epoch!==epoch || active.status.state!=="scanning")return;
    const nav=await this.navigation.call("status");
    if(this.active!==active || this.epoch!==epoch || active.status.state!=="scanning")return;
    const pose=nav.mapping?.pose;
    if(!pose || (!nav.ready && Math.hypot(pose.x-active.returnStation.x,pose.y-active.returnStation.y)>1)){
      active.returnReadySince ||= Date.now();
      active.status.message="Preparing the route to the station";
      active.status.customReturn={state:"preparing",message:active.status.message};
      if(Date.now()-active.returnReadySince>30000)throw Error("Station route could not become ready within 30 seconds");
      return;
    }
    active.status.customReturn=await this.navigation.call("dock",{map_id:active.id,station:active.returnStation});
    active.returnPending=false;
  }
  get ownsMotion() {
    const a=this.active;
    return !!a && ["scanning","locating"].includes(a.status.state) &&
      (a.status.mode === "explore" || a.status.localization === "locating" ||
       !!a.returnPending || !!a.status.customReturn && !["failed","docked","cancelled"].includes(a.status.customReturn.state));
  }
  get exploring() {
    return (
      (this.active?.status.mode === "explore" || this.active?.status.customReturn && !["failed","docked","cancelled"].includes(this.active.status.customReturn.state)) &&
      this.active.status.state === "scanning"
    );
  }
  async checkpoint(active) {
    diagnosticState("mapping", active.status.state, {
      map: active.id,
      mode: active.status.mode,
      error: active.status.error || null,
    });
    const m = await this.load(active.id);
    if(active.scanner.backend==="native" && active.status.state!=="scanning"){
      try{const snapshot=await this.engine.nativeMapping("snapshot");if(snapshot.map.cells.length && snapshot.close_map.cells.length)active.scanner.nativeSnapshot=snapshot;}catch{}
    }
    m.checkpoint = active.scanner.checkpoint();
    m.exploration = active.explorer?.checkpoint?.();
    m.cells = m.checkpoint.cells;
    if(active.scanner.backend==="slam_toolbox" && active.scanner.structuralSnapshot){
      const snapshot=active.scanner.structuralSnapshot;
      m.structure=structuralPlan(snapshot.cells,m.structure,snapshot.sequence,snapshot.keyframes);
    }
    if(m.displayAngle==null){
      const walls=m.structure?.walls.filter(w=>w.observations>=2).map(w=>w.points)||supportedWalls(m.cells,m.checkpoint.keyframes),length=walls.reduce((n,[a,b])=>n+Math.hypot(b[0]-a[0],b[1]-a[1]),0);
      if(walls.length>=3 && length>3){
        const vector=walls.reduce((v,[a,b])=>{const t=4*Math.atan2(b[1]-a[1],b[0]-a[0]),w=Math.hypot(b[0]-a[0],b[1]-a[1]);return [v[0]+Math.cos(t)*w,v[1]+Math.sin(t)*w]},[0,0]);
        m.displayAngle=Math.atan2(vector[1],vector[0])*45/Math.PI;
      }
    }
    active.wallCandidates=[...(active.status.deep && m.structure?.floor?.boundary?.length ? [] : m.structure?.walls.filter(w=>w.observations>=2).map(({id,points})=>({id,points}))||[]),...(m.structure?.floor?.boundary||[]).filter(e=>(active.status.deep || e.kind==='unobserved')&&Math.hypot(e.points[1][0]-e.points[0][0],e.points[1][1]-e.points[0][1])>=(active.status.deep ? .3 : .8)).map((e,i)=>({id:`edge-${i}`,points:e.points,unknown:e.kind==='unobserved'}))].slice(0,200);
    if(active.station){m.station=retainStation(m.station,active.station,active.stationRequested);active.station=m.station;}
    m.scan = {
      ...active.status,
      state:
        ["scanning","locating"].includes(active.status.state)
          ? "interrupted"
          : active.status.state,
    };
    if (m.scan.state === "interrupted")
      m.scan.message =
        "HQ stopped. Locate Alfred in the saved map before continuing.";
    await this.save(m);
    active.lastSave = Date.now();
  }
  async localize(scanner, signal) {
    await this.engine.stop();
    const first = (await this.engine.lidar()).result;
    if (scanAge(first)>750) throw Error("Waiting for fresh LiDAR to locate Alfred.");
    const result = await new Promise((resolve,reject) => {
      const worker = new Worker(new URL("./localization-worker.mjs", import.meta.url), {workerData:{scan:first, checkpoint:scanner.checkpoint()}});
      const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);worker.terminate();error?reject(error):resolve(value);};
      const abort=()=>finish(Error("Position search cancelled."));
      const timer=setTimeout(()=>finish(Error("Position search timed out. Try Locate again.")),10000);
      worker.once("message",v=>finish(v.error?Error(v.error):null,v.result));
      worker.once("error",e=>finish(e));
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted)abort();
    });
    const second=(await this.engine.lidar()).result;
    if(second.sequence===first.sequence || scanAge(second)>750)throw Error("Waiting for a second fresh scan to verify position.");
    const reference=scanner.grid().filter(c=>c[2]>=2).map(c=>[(c[0]+.5)*.05,(c[1]+.5)*.05]);
    const verified=align(localPoints(second),reference,result.pose);
    if(!verified.ok || verified.coverage<.8 || verified.rms>.055 || Math.hypot(verified.pose.x-result.pose.x,verified.pose.y-result.pose.y)>.08 || Math.abs(Math.atan2(Math.sin(verified.pose.theta-result.pose.theta),Math.cos(verified.pose.theta-result.pose.theta)))>.08)
      throw Error("Position match changed. Keep Alfred still and locate again.");
    scanner.pose=verified.pose;
    scanner.reference=reference;
    scanner.lastSequence=second.sequence;
    return {...verified, localization:"located", localizedAt:Date.now(), frames:scanner.frames, loopClosures:scanner.loopClosures};
  }
  async scan(id, action, options = {}) {
    const requestedEpoch = this.epoch;
    if (["pause", "finish"].includes(action) && this.active?.id === id) {
      this.epoch++;
      this.active.status.state = "paused";
      clearTimeout(this.timer);
      await this.engine.stop();
    }
    return this.serial(async () => {
      const m = await this.load(id);
      if ((action === "start" && !["experimental","native"].includes(options.backend)) || m.checkpoint?.backend === "slam_toolbox") return this.graphScan(m,action,options,requestedEpoch);
      if ((action === "start" && options.backend === "native") || m.checkpoint?.backend === "native") {
        if(["start","resume"].includes(action) && (options.mode||m.scan.mode||"explore")!=="manual")throw Error("This is a legacy native map. Create a new map for automatic exploration, or choose Manual capture.");
        return this.nativeScan(m, action, options, requestedEpoch);
      }
      if (action === "start" || action === "resume" || action === "locate") {
        if (this.active && this.active.id !== id) {
          if (this.active.status.state === "scanning")
            throw Error("Finish or pause the other active scan first.");
          this.active = null;
        }
        if (action === "start" && this.active)
          throw Error("A scan is already active.");
        if (["resume", "locate"].includes(action) && this.active?.status.state === "scanning")
          throw Error("Scan is already running.");
        const mode =
          action === "start"
            ? options.mode || "manual"
            : options.mode ||
              this.active?.status.mode ||
              m.scan.mode ||
              "manual";
        if (!["manual", "explore"].includes(mode))
          throw Error("Choose manual capture or exploration.");
        const minutes = Number(options.minutes ?? m.scan.minutes ?? 10);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60)
          throw Error("Scan duration must be between 1 and 60 minutes.");
        if (action === "start" && m.cells.length)
          throw Error("Use Resume to extend this map, or create a new map.");
        let native;
        if (action !== "locate" && mode === "explore" && this.native) {
          native = await this.native.call("status");
          if (native.work.state !== 0)
            throw Error("Stop the firmware task before HQ exploration.");
        }
        const scanner =
          action !== "start"
            ? Scanner.restore(this.active?.scanner.checkpoint() || m.checkpoint)
            : new Scanner();
        let quality;
        if(action !== "start") quality=await this.localize(scanner, options.signal);
        else {
          const first = await this.engine.lidar();
          quality = scanner.ingest(first.result);
          quality.localization="located";
        }
        const explorer = mode === "explore" && action !== "locate" ? new Explorer(minutes, this.active?.explorer?.checkpoint?.() || m.exploration || {}) : null;
        if (explorer) {
          await this.engine.mappingDrive({ linear: 0, angular: 0 });
        }
        options.signal?.throwIfAborted();
        if (this.epoch !== requestedEpoch)
          throw Error("Scan start cancelled by Stop.");
        this.epoch++;
        this.active = {
          id,
          scanner,
          explorer,
          lastSave: 0,
          status: {
            mode,
            minutes,
            state: action === "locate" ? "paused" : "scanning",
            ...quality,
            error: null,
            message: action === "locate" ? "Position found in saved map. Ready to resume." :
              mode === "explore"
                ? "Planning exploration"
                : "Capture active. Drive slowly in Cockpit.",
          },
        };
        await this.checkpoint(this.active);
        if (options.signal?.aborted) {
          this.active.status.state = "paused";
          await this.checkpoint(this.active);
          throw Error("Scan request cancelled.");
        }
        this.schedule();
        return this.get(id);
      }
      if (this.active?.id !== id) {
        if (action === "finish" && m.checkpoint) {
          m.scan.state = "finished";
          await this.save(m);
          return this.get(id);
        }
        throw Error("No active scan for this map.");
      }
      if (action === "pause") {
        this.active.status.state = "paused";
        this.active.status.message = "Paused. Resume will locate Alfred in this map.";
        await this.checkpoint(this.active);
        return this.get(id);
      }
      if (action === "finish") {
        this.active.status.state = "finished";
        this.active.status.message = "Scan saved.";
        await this.checkpoint(this.active);
        this.active = null;
        return this.get(id);
      }
      throw Error("Unknown scan action");
    });
  }
  schedule() {
    clearTimeout(this.timer);
    if (["scanning","locating"].includes(this.active?.status.state))
      this.timer = setTimeout(() => this.tick(), this.active?.status.customReturn ? 300 : this.exploring ? 70 : 300);
    this.timer?.unref();
  }
  async tick() {
    if(this.active?.engineLocate)return this.engineLocateTick();
    if(this.active?.scanner.backend === "slam_toolbox") return this.graphTick();
    if(this.active?.scanner.backend === "native") return this.nativeTick();
    await this.serial(async () => {
      const a = this.active,
        epoch = this.epoch;
      if (!a || a.status.state !== "scanning") return;
      try {
        const [value, bumper] = await Promise.all([
          this.engine.lidar(),
          a.explorer ? this.engine.bumpers() : null,
        ]);
        if (epoch !== this.epoch) return;
        if(a.explorer && (!bumper.result?.fresh || bumper.result.cliff_raw == null || bumper.result.wheel_lift_raw == null || scanAge(value.result)>750)) {
          a.waitingSince ||= Date.now();
          await this.engine.stop();
          a.status.message = "Waiting for fresh sensor data; wheels stopped.";
          if(Date.now()-a.waitingSince>2500)throw Error("Sensor data did not recover. Exploration paused.");
          return;
        }
        a.waitingSince = null;
        let quality;
        if (value.result.sequence !== a.scanner.lastSequence)
          quality = a.scanner.ingest(value.result);
        else if (scanAge(value.result) > 1500)
          throw Error("Waiting for fresh LiDAR.");
        if (quality) Object.assign(a.status, quality);
        a.status.error = null;
        a.status.observedAt = Date.now();
        if (a.explorer) {
          a.status.sensors = bumper.result;
          const next = a.explorer.step(a.scanner, value.result, bumper.result);
          a.status.message = next.message;
          a.status.path = next.path || [];
          if (next.done) {
            await this.engine.stop();
            a.status.state = "finished";
            await this.checkpoint(a);
            this.active = null;
            return;
          }
          if (epoch !== this.epoch) return;
          await this.engine.mappingDrive({
            linear: next.linear,
            angular: next.angular,
          });
        }
        if (Date.now() - a.lastSave > 2000) await this.checkpoint(a);
      } catch (error) {
        if (epoch !== this.epoch) return;
        if(a.explorer && /safety sensors unavailable|LiDAR unavailable/i.test(error.message)) {
          a.waitingSince ||= Date.now();
          if(Date.now()-a.waitingSince<=2500) {
            a.status.message="Waiting for fresh sensor data; wheels stopped.";
            return; // Engine rejected motion and stopped its wheels.
          }
        }
        if(a.explorer && /front bumper pressed/i.test(error.message)) {
          a.status.message="Bumper contact; stopping.";
          return; // Engine already stopped; next fresh sensor sample starts recovery.
        }
        a.status.error = error.message;
        a.status.message = error.message;
        a.status.state = "paused";
        this.epoch++;
        try {
          await this.engine.stop();
        } catch {}
        await this.checkpoint(a);
      }
    }).catch(() => {});
    this.schedule();
  }
  prepareManualDrive(vector) {
    const a=this.active;
    if(!a || a.status.mode!=="manual" || a.status.state!=="scanning" || !a.status.docked ||
       (!vector.linear && !vector.angular) || Date.now()-(a.manualWakeReadyAt||0)<5000)return;
    if(!a.manualWakeTask){
      a.manualWakeTask=this.engine.wakeForMapping().then(()=>{a.manualWakeReadyAt=Date.now();a.manualWakeError=null;})
        .catch(error=>{a.manualWakeError=error.message;}).finally(()=>{a.manualWakeTask=null;});
    }
    // Held cockpit input retries. No delayed velocity is queued behind wake.
    throw Error(a.manualWakeError || "Waking mapping sensors; keep the drive control held.");
  }
  observeGraphStation(active) {
    if(!this.engine.dockStatus || active.stationTask || Date.now()-(active.lastStationCheck||0)<2000)return;
    active.lastStationCheck=Date.now();
    active.stationTask=this.engine.dockStatus().then(dock=>{
      if(this.active===active)active.dockObservation=dock;
      // Use the current tracked pose after the asynchronous sensor read. Never
      // attach a response to a map that was switched, paused or lost tracking.
      if(this.active!==active || active.status.state!=="scanning" || active.telemetryFaultSince ||
         Date.now()-(active.status.observedAt||0)>750 || !dock.docked)return;
      const observed=stationObservation(dock,active.status.pose,active.status.localization);
      if(!active.station || Math.hypot(active.station.x-observed.x,active.station.y-observed.y)>.05){
        active.station=retainStation(active.station,observed,active.stationRequested);active.lastSave=0;
      }
    }).catch(error=>diagnosticState("mapping-station","unavailable",{error:error.message}))
      .finally(()=>{active.stationTask=null;});
    return active.stationTask;
  }
  async completeGraphLocation(active) {
    await this.navigation.call("mapping/pause");
    active.status.state="paused";
    active.status.localization="located";
    active.status.error=null;
    active.status.message="Position found";
    active.pendingAction=null;
    if(!this.engine.dockStatus)return;
    try {
      const dock=await this.engine.dockStatus();
      if(dock.docked){
        active.station=retainStation(active.station,stationObservation(dock,active.status.pose,active.status.localization),active.stationRequested);
        active.status.message="Position found. Station marked.";
      } else if(active.station?.method==="measured-departure") {
        active.status.message="Position found. Station marked from measured departure.";
      } else if(active.stationRequested) {
        active.status.message="Position found, but charging contact is no longer detected. Station not updated.";
      }
    } catch(error) {
      diagnosticState("mapping-station","unavailable",{error:error.message});
      if(active.stationRequested)active.status.message="Position found. Station detection unavailable; marker not updated.";
    }
  }
  async locateOnboard(m,options,requestedEpoch){
    if(this.active?.id===m.id && this.active.engineLocate && this.active.status.state==="locating")return this.get(m.id);
    if(this.active && ["scanning","locating"].includes(this.active.status.state))throw Error("Pause the current scan first.");
    const grid=m.checkpoint?.nativeGrid;
    if(!grid?.cells?.length)throw Error("Saved map grid unavailable.");
    await this.engine.wakeForMapping(options.signal);
    options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
    await this.engine.localization("map",{map_id:m.id,revision:String(m.revision),grid});
    options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
    await this.engine.localization("locate",{map_id:m.id});
    options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
    this.active={id:m.id,scanner:new GraphScanner(m.checkpoint),station:m.station,engineLocate:true,status:{...m.scan,state:"locating",localization:"locating",pose:null,error:null,message:"Engine is locating Alfred"}};
    this.epoch++;this.schedule();return this.get(m.id);
  }
  async engineLocateTick(){
    const a=this.active;if(!a?.engineLocate)return;
    try{
      const location=await this.engine.localization();
      if(this.active!==a)return;
      a.status.message=location.message;
      if(location.map_id===a.id && location.state==="located" && location.pose){
        a.status={...a.status,state:"paused",localization:"located",pose:location.pose,error:null,message:"Position tracked by engine"};
        const m=await this.load(a.id);m.scan={...a.status};await this.save(m);
      }
    }catch(error){if(this.active===a)a.status.message=error.message;}
    this.schedule();
  }
  async graphScan(m,action,options,requestedEpoch){
    const id=m.id;
    if(action==="locate" && !options.station && typeof this.engine.localization==="function")return this.locateOnboard(m,options,requestedEpoch);
    if(this.active?.engineLocate && ["pause","finish"].includes(action)){
      this.active.status.state="paused";this.active.status.localization="cancelled";this.active.status.message="Map view paused; engine tracking continues";
      clearTimeout(this.timer);return this.get(id);
    }
    if(["pause","finish"].includes(action)){
      try{await this.navigation.call("mapping/pause");}finally{await this.engine.stop();}
      if(this.active?.id===id){
        const structure=await this.navigation.call("structure");
        if(structure?.map_id===id)this.active.scanner.acceptStructure(structure);
        this.active.status.state=action==="finish"?"finished":"paused";if(this.active.status.localization==="locating")this.active.status.localization="cancelled";this.active.pendingAction=null;this.active.status.error=null;this.active.status.message=action==="finish"?"Map saved.":"Paused.";
        await this.checkpoint(this.active);if(action==="finish")this.active=null;
      }
      return this.get(id);
    }
    if(!["start","resume","locate"].includes(action))throw Error("Unknown mapping action.");
    if(this.active?.status.state==="locating"){
      if(this.active.id===id && action==="locate")return this.get(id);
      throw Error("Position search is in progress. Pause it before starting another operation.");
    }
    if(this.active?.status.state==="scanning")throw Error("Pause the current scan first.");
    // Locate observes position; it must not replace the saved exploration setup.
    const scanOptions=action==="locate"?{}:options;
    const deep=scanOptions.mode==="deep" || (scanOptions.mode==null && !!m.scan.deep);
    const mode=scanOptions.mode==="deep"?"explore":scanOptions.mode||m.scan.mode||"explore",minutes=Number(scanOptions.minutes??m.scan.minutes??10);
    if(!["manual","explore"].includes(mode)||!Number.isFinite(minutes)||minutes<1||minutes>60)throw Error("Invalid scan options.");
    if(action==="start" && m.cells.length)throw Error("Use Resume to extend this map.");
    let stationPrior, docked=false;
    if(this.engine.dockStatus && (action==="locate" || options.station || m.station)){
      const detected=await this.engine.dockStatus().catch(error=>{if(options.station)throw error;return null;});
      if(options.station && !detected.docked)throw Error("Charging contacts do not detect the station. Dock Alfred before locating it.");
      if(detected?.docked && m.station?.source=== "docked-robot-pose" && ["x","y","theta"].every(k=>Number.isFinite(m.station[k])))stationPrior=m.station;
      docked=!!detected?.docked;
      m.stationDetection=detected;await this.save(m);
    }
    const wake=await this.engine.wakeForMapping(options.signal);
    let native=await this.engine.nativeMapping("status");
    let firmwareWork=native.reports?.["/task/WorkState"]?.bytes;
    // Our zero-speed wake enters native remote mode briefly. Observe it ending;
    // never cancel another controller or assume a persistent task is ours.
    for(let attempt=0;wake?.woke && firmwareWork?.[0]===9 && firmwareWork[2]!==0 && attempt<4;attempt++){
      await new Promise(resolve=>setTimeout(resolve,1000));
      options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
      native=await this.engine.nativeMapping("status");
      firmwareWork=native.reports?.["/task/WorkState"]?.bytes;
    }
    if(!firmwareWork || firmwareWork.length<3)throw Error("Firmware task status unavailable. Mapping has not started.");
    if(firmwareWork[2]!==0){
      const task={0:"automatic cleaning",1:"area cleaning",2:"custom cleaning",3:"edge cleaning",4:"AI cleaning",5:"return-to-station",6:"go-to",8:"relocation",9:"remote control",10:"AI guide",11:"checkpoint",12:"patrol",13:"dust collection",15:"native mapping"}[firmwareWork[0]]||`task ${firmwareWork[0]}`;
      throw Error(`Firmware ${task} is ${firmwareWork[2]===2?"paused":"active"}. End that task before HQ mapping.`);
    }
    await this.engine.nativeMapping("backend-off");await this.engine.nativeMapping("pause");
    let nav,grid;
    try{
      const preparation=await this.navigation.call(`mapping/${action}`,{id,boot_id:native.boot_id,station_prior:stationPrior,docked,allow_motion:action==="locate" || options.allowMotion===true});
      if(preparation.location?.state==="locating"){
        const scanner=new GraphScanner(m.checkpoint);
        this.active={id,scanner,station:m.station,stationRequested:!!options.station,pendingAction:action,locatingSince:Date.now(),lastSave:0,lastGrid:0,deadline:Date.now()+minutes*60000,status:{backend:"slam_toolbox",mode,deep,deepPass:deep?m.scan.deepPass:null,minutes,state:"locating",localization:"locating",pose:null,frames:scanner.frames,message:preparation.location.message,error:null}};
        options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
        this.epoch++;await this.checkpoint(this.active);this.schedule();return this.get(id);
      }
      for(let attempt=0;attempt<20;attempt++){
        options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
        [nav,grid]=await Promise.all([this.navigation.call("status"),this.navigation.call("grid")]);
        if((mode==="manual" || nav.ready) && nav.mapping.pose && grid?.cells.length)break;
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      if((mode!=="manual" && !nav.ready) || !nav.mapping.pose || !grid?.cells.length)throw Error("Waiting for SLAM position and map.");
      const scanner=new GraphScanner(action==="resume"?m.checkpoint:null),lidar=await this.engine.lidar();
      const quality=scanner.update(grid,{boot_id:native.boot_id,pose:nav.mapping.pose},lidar.result);
      this.active={id,scanner,station:m.station,stationRequested:!!options.station,lastSave:0,lastGrid:Date.now(),deadline:Date.now()+minutes*60000,status:{...quality,mode,deep,deepPass:deep?m.scan.deepPass:null,minutes,state:"scanning",message:mode==="explore"?"Exploring":"Capturing map",error:null}};
      options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
      if(action==="locate")await this.completeGraphLocation(this.active);
      else if(mode==="explore"){await this.checkpoint(this.active);await this.navigation.call("start",{deep,deep_pass:this.active.status.deepPass,walls:this.active.wallCandidates});}
      options.signal?.throwIfAborted();if(this.epoch!==requestedEpoch)throw Error("Scan cancelled.");
      this.epoch++;await this.checkpoint(this.active);this.schedule();return this.get(id);
    }catch(error){
      try{await this.navigation.call("mapping/pause");}catch{}try{await this.engine.stop();}catch{}
      if(this.active?.id===id){this.active.status.state="paused";this.active.status.error=error.message;await this.checkpoint(this.active);}
      throw error;
    }
  }
  async graphTick(){
    await this.serial(async()=>{
      const a=this.active,epoch=this.epoch;if(!a||!["scanning","locating"].includes(a.status.state))return;
      try{
        const [nav,lidar,grid]=await Promise.all([this.navigation.call("heartbeat",{walls:a.wallCandidates||[]}).catch(error=>{throw Error("Controller heartbeat: "+error.message);}),this.engine.lidar().catch(error=>{throw Error("LiDAR read: "+error.message);}),Date.now()-a.lastGrid>900?this.navigation.call("grid").catch(error=>{throw Error("Map read: "+error.message);}):null]);
        if(epoch!==this.epoch)return;
        a.returnFaultSince=null;
        if(!a.structureTask && Date.now()-(a.lastStructure||0)>5000){
          a.lastStructure=Date.now();
          a.structureTask=this.navigation.call("structure",{sequence:a.scanner.structuralSnapshot?.sequence}).then(structure=>{
            if(this.active===a && epoch===this.epoch && structure?.map_id===a.id)a.scanner.acceptStructure(structure);
          }).catch(error=>diagnosticState("mapping-structure","unavailable",{error:error.message})).finally(()=>{a.structureTask=null;});
        }
        if(nav.mapping.location?.state==="locating" && a.status.localization!=="locating"){
          a.status.state="locating";a.status.localization="locating";a.status.pose=null;
          a.pendingAction="resume";a.locatingSince=Date.now();
          a.status.message=nav.mapping.location.message;
        }
        if(a.status.localization==="locating"){
          if(nav.mapping.location.state==="failed")throw Error(nav.mapping.location.message);
          if(nav.mapping.location.state!=="located" || (a.status.mode!=="manual" && !nav.ready) || !nav.mapping.pose){
            a.locatingSince ||= Date.now();
            a.status.message=nav.mapping.location.state==="located" ? (nav.mapping.tracking_error || nav.message || "Starting navigation") : nav.mapping.location.message;
            if(nav.mapping.location.source!=="engine" && Date.now()-a.locatingSince>(a.pendingAction==="locate" || a.returnPending?75000:25000))throw Error(`${a.status.message}. Preparation timed out; scan paused.`);
            return;
          }
          if(nav.mapping.map_id!==a.id)throw Error("Localized map does not match this scan.");
          Object.assign(a.status,a.scanner.update(grid,{boot_id:nav.mapping.boot_id,pose:nav.mapping.pose},lidar.result),{localization:"located",message:"Position found"});
          if(a.pendingAction==="locate"){
            const station=nav.mapping.location.station;
            if(station?.method==="measured-departure" && ["x","y","theta"].every(k=>Number.isFinite(station[k])))a.station=retainStation(a.station,{...station,label:"Station"},a.stationRequested);
            await this.completeGraphLocation(a);
            await this.checkpoint(a);return;
          }
          if(a.status.mode==="explore")await this.navigation.call("start",{deep:a.status.deep,deep_pass:a.status.deepPass,walls:a.wallCandidates||[]});
          a.status.state="scanning";a.pendingAction=null;await this.checkpoint(a);return;
        }
        if(nav.mapping.map_id!==a.id || !nav.mapping.capture)throw Error("Mapping session changed; scan paused.");
        if(a.returnPending){await this.startCustomReturn(a);return;}
        if(a.status.customReturn && nav.docking){
          a.status.customReturn=nav.docking;
          if(!nav.mapping.pose && nav.docking.pose && !nav.docking.error)nav.mapping.pose=nav.docking.pose;
          if(["docked","failed"].includes(nav.docking.state)){
            if(nav.docking.error?.includes("Firmware task"))await this.engine.stopNativeReturn().catch(()=>{});
            await this.engine.stop();
            if(nav.mapping.pose)Object.assign(a.status,a.scanner.update(grid,{boot_id:nav.mapping.boot_id,pose:nav.mapping.pose},lidar.result));
            if(nav.docking.state==="docked")await this.observeGraphStation(a);
            await this.navigation.call("mapping/pause");
            a.status.state="paused";a.status.message=nav.docking.message;a.status.error=nav.docking.error;
            await this.checkpoint(a);return;
          }
        }
        this.observeGraphStation(a);
        const age=scanAge(lidar.result);
        a.status.docked=!!(a.dockObservation?.docked && Date.now()-a.dockObservation.observedAt<5000);
        if(a.status.mode==="manual" && a.status.docked && age>750){
          a.telemetryFaultSince=null;a.status.error=null;a.status.message="Docked. Map saved; drive to continue.";
          if(Date.now()-a.lastSave>2000)await this.checkpoint(a);
          return;
        }
        const telemetryIssue=age>750 ? `LiDAR is stale (${Math.round(age)} ms)` : ((a.status.mode!=="manual" && !nav.ready) || !nav.mapping.pose) ? (nav.mapping.tracking_error || nav.message || "Mapping position unavailable") : null;
        if(telemetryIssue){
          a.telemetryFaultSince ||= Date.now();
          a.status.message=`Stopped while recovering: ${telemetryIssue}`;
          a.status.telemetry=nav.telemetry || {lidar_age_ms:age};
          await this.engine.stop();
          if(Date.now()-a.telemetryFaultSince>=5000 || (a.status.mode==="explore" && !nav.active))throw Error(`${telemetryIssue}. Scan paused; Resume retries localization.`);
          return;
        }
        a.telemetryFaultSince=null;a.status.error=null;
        if(a.status.mode==="explore"&&!nav.active)throw Error(nav.stop_reason||nav.message||"Navigation paused.");
        Object.assign(a.status,a.scanner.update(grid,{boot_id:nav.mapping.boot_id,pose:nav.mapping.pose},lidar.result));if(grid)a.lastGrid=Date.now();
        a.status.message=a.status.mode==="explore"?nav.message:"Capturing map. Drive from Cockpit.";a.status.path=nav.path||[];a.status.graphNodes=nav.mapping.graph_nodes;a.status.graphEdges=nav.mapping.graph_edges;a.status.observedAt=Date.now();
        if(a.status.customReturn)a.status.message=a.status.customReturn.message;
        if(nav.wall_verifications)a.status.wallVerifications=nav.wall_verifications;
        if(a.status.deep && nav.deep_pass)a.status.deepPass=nav.deep_pass;
        if(nav.frontiers?.markers){
          a.status.boundaryMarkers=nav.frontiers.markers;
          a.status.unresolvedFrontiers=nav.frontiers.disconnected;
        }
        if(a.status.mode==="explore" && (nav.exploration==="exploration_complete"||Date.now()>a.deadline)){
          await this.navigation.call("mapping/pause");
          const remaining=nav.frontiers?.total??nav.frontiers?.disconnected??0;
          const deepRemaining=a.status.deepPass?.remaining||0;
          const unfinished=(nav.wall_verifications||[]).filter(v=>["not_reached","approach_blocked"].includes(v.result)&&!(nav.wall_verifications||[]).some(q=>["contact","close_scan","observed"].includes(q.result)&&Math.hypot(q.point[0]-v.point[0],q.point[1]-v.point[1])<.55)).length;
          a.status.unresolvedFrontiers=remaining;
          a.status.state=nav.failed_goals||remaining||unfinished||deepRemaining||Date.now()>a.deadline?"paused":"finished";
          a.status.message=deepRemaining?`Deep pass saved: ${a.status.deepPass.verified}/${a.status.deepPass.total} sections checked. ${deepRemaining} still need inspection.`:remaining?`${remaining} unmapped boundaries need another approach. Map saved for Resume.`:unfinished?`${unfinished} surface checks remain unfinished. Map saved for Resume.`:nav.failed_goals?"Some areas have not been reached yet. Map saved for Resume.":Date.now()>a.deadline?"Scan time reached. Map saved for Resume.":"Map saved.";
        }
        if(Date.now()-a.lastSave>2000||a.status.state!=="scanning")await this.checkpoint(a);
      }catch(error){
        if(epoch!==this.epoch)return;
        if(a.status.customReturn && /timeout|timed out|fetch failed|socket|ECONN|aborted/i.test(error.message)){
          a.returnFaultSince ||= Date.now();
          await this.engine.stop().catch(()=>{});
          if(Date.now()-a.returnFaultSince<5000){a.status.message="Reconnecting while returning: "+error.message;return;}
        }
        a.status.state="paused";if(a.status.localization==="locating")a.status.localization="failed";a.pendingAction=null;a.status.error=error.message;a.status.message=error.message;this.epoch++;
        try{await this.navigation.call("mapping/pause");}catch{}try{await this.engine.stop();}catch{}await this.checkpoint(a);
      }
    }).catch(()=>{});this.schedule();
  }
  async nativeScan(m, action, options, requestedEpoch) {
    const id=m.id;
    if(["pause","finish"].includes(action)) {
      try {await this.navigation.call("pause");} finally {await this.engine.stop();}
      await this.engine.nativeMapping("pause");
      if(this.active?.id===id){this.active.status.state=action==="finish"?"finished":"paused";this.active.status.message=action==="finish"?"Scan saved.":"Paused.";await this.checkpoint(this.active);if(action==="finish")this.active=null;}
      return this.get(id);
    }
    if(!["start","resume"].includes(action))throw Error("Saved-map localization is being integrated; keep Alfred in this map's frame for now.");
    if(this.active && this.active.id!==id && this.active.status.state==="scanning")throw Error("Pause the active scan first.");
    if(action==="start" && m.cells.length)throw Error("Use Resume to extend this map.");
    // Persisted native map loading/relocalization must be verified before crossing robot sessions.
    if(action==="resume"){
      const status=await this.engine.nativeMapping("status");
      if(!m.checkpoint?.bootId || m.checkpoint.bootId!==status.boot_id)throw Error("Robot restarted; saved-map relocation is required before resuming.");
    }
    const mode=options.mode||m.scan.mode||"explore",minutes=Number(options.minutes??m.scan.minutes??10);
    if(!["manual","explore"].includes(mode)||!Number.isFinite(minutes)||minutes<1||minutes>60)throw Error("Invalid scan options.");
    await this.engine.wakeForMapping(options.signal);
    let work;
    for(let attempt=0;attempt<5;attempt++){
      const report=(await this.engine.nativeMapping("status")).reports?.["/task/WorkState"]?.bytes;
      work=report?{type:report[0],subtype:report[1],state:report[2]}:(await this.native.call("status")).work;
      if(work.state===0)break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(work.state!==0)throw Error("Stop the firmware task before HQ mapping.");
    await this.engine.stop();
    await this.engine.nativeMapping(action==="start"?"start":"resume");
    if(this.epoch!==requestedEpoch || options.signal?.aborted){
      await this.engine.stop();await this.engine.nativeMapping("pause");throw Error("Scan cancelled.");
    }
    const scanner=action==="resume"?(this.active?.id===id?this.active.scanner:new NativeScanner(m.checkpoint)):new NativeScanner();
    const [grid,status,lidar]=await Promise.all([this.engine.nativeMapping("grid"),this.engine.nativeMapping("status"),this.engine.lidar()]);
    const quality=scanner.update(grid,status,lidar.result);
    this.active={id,scanner,lastSave:0,lastGrid:Date.now(),deadline:Date.now()+minutes*60000,status:{...quality,mode,minutes,state:"scanning",message:"Starting navigation",error:null}};
    this.epoch++;
    const startEpoch=this.epoch;
    try {
      if(mode==="explore"){
        for(let attempt=0;attempt<5;attempt++){
          options.signal?.throwIfAborted();
          const nav=await this.navigation.call("status");if(nav.ready)break;
          await new Promise(resolve=>setTimeout(resolve,200));
        }
        if(this.epoch!==startEpoch)throw Error("Scan cancelled by Stop.");
        await this.navigation.call("start");
        if(this.epoch!==startEpoch || options.signal?.aborted){await this.navigation.call("pause");throw Error("Scan cancelled by Stop.");}
      }
    }
    catch(error){
      try{await this.navigation.call("pause");}catch{}
      try{await this.engine.stop();await this.engine.nativeMapping("pause");}catch{}
      this.active.status.state="paused";this.active.status.error=error.message;this.active.status.message=error.message;await this.checkpoint(this.active);throw error;}
    await this.checkpoint(this.active);this.schedule();return this.get(id);
  }
  async nativeTick(){
    await this.serial(async()=>{
      const a=this.active,epoch=this.epoch;if(!a||!["scanning","locating"].includes(a.status.state))return;
      try {
        const [status,lidar,grid]=await Promise.all([this.engine.nativeMapping("status"),this.engine.lidar(),Date.now()-a.lastGrid>900?this.engine.nativeMapping("grid"):null]);
        if(epoch!==this.epoch)return;
        if(scanAge(lidar.result)>750)throw Error("LiDAR is stale; scan paused.");
        Object.assign(a.status,a.scanner.update(grid,status,lidar.result));if(grid)a.lastGrid=Date.now();
        a.status.observedAt=Date.now();a.status.error=null;
        if(a.status.mode==="explore"){
          const navigation=await this.navigation.call("heartbeat");
          a.status.message=navigation.message;a.status.path=navigation.path||[];
          if(!navigation.active)throw Error(navigation.message||"Navigation paused.");
          if(navigation.exploration==="exploration_complete" || Date.now()>a.deadline){await this.navigation.call("pause");await this.engine.nativeMapping("pause");a.status.state=navigation.failed_goals?"paused":"finished";a.status.message=navigation.failed_goals?"Some areas could not be reached; map saved for another attempt.":navigation.exploration==="exploration_complete"?"No reachable unexplored areas remain.":"Scan time reached; map saved.";}
        }else a.status.message="Capturing native map. Drive from Cockpit.";
        if(Date.now()-a.lastSave>2000 || a.status.state!=="scanning")await this.checkpoint(a);
      }catch(error){
        if(epoch!==this.epoch)return;
        a.status.state="paused";if(a.status.localization==="locating")a.status.localization="failed";a.pendingAction=null;a.status.error=error.message;a.status.message=error.message;this.epoch++;
        try{await this.navigation.call("pause");}catch{}
        try{await this.engine.stop();await this.engine.nativeMapping("pause");}catch{}
        await this.checkpoint(a);
      }
    }).catch(()=>{});
    this.schedule();
  }
  async stopExploration() {
    this.epoch++;
    if (this.ownsMotion)
      return this.scan(this.active.id, "pause");
  }
  async pauseActive() {
    this.epoch++;
    if (this.active) return this.scan(this.active.id, "pause");
    try { await this.navigation.call("pause"); } catch {}
    await this.engine.stop();
    return null;
  }
}
