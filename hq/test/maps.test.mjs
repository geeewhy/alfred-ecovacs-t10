import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { polygon, area, split, merge } from "../src/maps/geometry.mjs";
import { align, transform, Scanner, outlines } from "../src/maps/scanner.mjs";
import { MapService } from "../src/maps/map-service.mjs";
test("split and union conserve concave geometry; reject crossing polygons", () => {
  const g = polygon([
    [0, 0],
    [4, 0],
    [4, 1],
    [1, 1],
    [1, 4],
    [0, 4],
  ]);
  const parts = split(g, [0.5, -1], [0.5, 5]);
  assert.equal(area(g), 7);
  assert.equal(
    parts.reduce((s, p) => s + area(p), 0),
    7,
  );
  assert.equal(area(merge(parts)), 7);
  assert.throws(() =>
    polygon([
      [0, 0],
      [2, 2],
      [0, 2],
      [2, 0],
    ]),
  );
  assert.throws(() => split(g, [10, 0], [10, 5]));
});
test("scan matching recovers a small known motion and rejects unrelated returns", () => {
  const reference = [];
  for (let i = 0; i < 100; i++) {
    reference.push([i * 0.03, 2], [3, i * 0.02], [-1, i * 0.025]);
  }
  const motion = { x: 0.07, y: -0.04, theta: 0.025 };
  const inverse = {
    theta: -motion.theta,
    x: -Math.cos(motion.theta) * motion.x - Math.sin(motion.theta) * motion.y,
    y: Math.sin(motion.theta) * motion.x - Math.cos(motion.theta) * motion.y,
  };
  const points = transform(reference, inverse);
  const result = align(points, reference);
  assert.ok(result.ok);
  assert.ok(Math.abs(result.pose.x - motion.x) < 0.035);
  assert.ok(Math.abs(result.pose.theta - motion.theta) < 0.02);
  assert.equal(
    align(
      points.map((p) => [p[0] + 30, p[1] + 30]),
      reference,
    ).ok,
    false,
  );
});
test("capture rejects stale frames and vectors follow occupied cell boundaries", () => {
  const s = new Scanner();
  assert.throws(() =>
    s.ingest({ observed_at_unix_ms: 0, sequence: 1, points: [] }),
  );
  assert.equal(
    outlines([
      [0, 0, 3],
      [1, 0, 3],
    ]).length,
    6,
  );
});
test("map edits persist across service restart and reject stale revisions", async () => {
  const dir = await mkdtemp(tmpdir() + "/alfred-map-test-");
  try {
    const service = new MapService({}, dir);
    let m = await service.create({ name: "Test" });
    m = await service.edit(m.id, {
      revision: 0,
      action: "draw",
      points: [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
      name: "Room",
    });
    await assert.rejects(
      service.edit(m.id, { revision: 0, action: "rename-map", name: "Stale" }),
    );
    m = await new MapService({}, dir).get(m.id);
    assert.equal(m.areas[0].area, 4);
    assert.equal(m.areas[0].name, "Room");
    m = await service.edit(m.id, {
      revision: m.revision,
      action: "split",
      ids: [m.areas[0].id],
      points: [
        [1, -1],
        [1, 3],
      ],
    });
    assert.equal(m.areas.length, 2);
    m = await service.edit(m.id, {
      revision: m.revision,
      action: "merge",
      ids: m.areas.map((a) => a.id),
    });
    assert.equal(m.areas[0].area, 4);
    m = await service.edit(m.id, { revision: m.revision, action: "undo" });
    assert.equal(m.areas.length, 2);
    m = await service.edit(m.id, { revision: m.revision, action: "redo" });
    assert.equal(m.areas.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("paused capture retains its coordinate frame after HQ restart", async () => {
  const dir = await mkdtemp(tmpdir() + "/alfred-scan-test-");
  const points = Array.from({ length: 180 }, (_, i) => ({
    x: 2000 * Math.cos((i * Math.PI) / 90),
    y: 2000 * Math.sin((i * Math.PI) / 90),
  }));
  const engine = {
    stop: async () => {},
    lidar: async () => ({
      result: { sequence: 1, observed_at_unix_ms: Date.now(), points },
    }),
  };
  const service = new MapService(engine, dir);
  try {
    let m = await service.create({ name: "Scan" });
    m = await service.scan(m.id, "start", {backend:"experimental"});
    assert.equal(m.scan.state, "scanning");
    m = await service.scan(m.id, "pause");
    assert.equal(m.scan.state, "paused");
    const recovered = await new MapService(engine, dir).get(m.id);
    assert.equal(recovered.scan.state, "paused");
    assert.equal(recovered.resumable, true);
    assert.ok(recovered.cells.length > 0);
    m = await service.scan(m.id, "finish");
    assert.equal(m.scan.state, "finished");
    assert.equal(service.active, null);
  } finally {
    clearTimeout(service.timer);
    await rm(dir, { recursive: true, force: true });
  }
});

test("frontier planning tolerates isolated returns and retains sensor guards", async () => {
  const { frontierPath, Explorer } = await import("../src/maps/explorer.mjs");
  const cells = [];
  for (let x = -32; x <= 32; x++)
    for (let y = -32; y <= 32; y++) cells.push([x, y, -4]);
  const result = frontierPath(cells, { x: 0, y: 0 });
  assert.ok(result.path.length > 3);
  const blocked = frontierPath(
    [
      [0, 0, -1],
      [0, 1, 8],
      [1, 0, 8],
      [-1, 0, 8],
      [0, -1, 8],
    ],
    { x: 0, y: 0 },
  );
  assert.ok(blocked.path.length>0);
  const explorer = new Explorer();
  assert.throws(
    () =>
      explorer.step({}, {}, { fresh: true, cliff_raw: 1, wheel_lift_raw: 0 }),
    /Cliff/,
  );
  const scan={observed_at_unix_ms:Date.now(),points:[{x:130,y:0}]};
  const scanner={pose:{x:0,y:0,theta:0},grid:()=>cells};
  const sensors={fresh:true,cliff_raw:0,wheel_lift_raw:0,left:true,right:false};
  assert.equal(explorer.step(scanner,scan,sensors).linear,0);
  assert.equal(explorer.step(scanner,scan,sensors).linear,-.25);
  explorer.recovery.started=Date.now()-800;
  const turn=explorer.step(scanner,scan,{...sensors,left:false});
  assert.ok(turn.angular>0);
  assert.equal(turn.linear,0);
  explorer.recovery={phase:"back",started:Date.now()-1300,turn:.55};
  assert.throws(()=>explorer.step(scanner,scan,sensors),/did not release/);

});

test("pause invalidates an in-flight exploration tick before it can send motion", async () => {
  const dir = await mkdtemp(tmpdir() + "/alfred-stop-test-");
  let release,
    moves = 0,
    stops = 0;
  const engine = {
    stop: async () => {
      stops++;
    },
    lidar: () =>
      new Promise((r) => {
        release = r;
      }),
    bumpers: async () => ({ result: {} }),
    mappingDrive: async () => {
      moves++;
    },
  };
  const service = new MapService(engine, dir);
  try {
    const m = await service.create({ name: "Stop race" });
    const scanner = new Scanner();
    scanner.reference = [];
    service.active = {
      id: m.id,
      scanner,
      explorer: {},
      status: { state: "scanning", mode: "explore" },
    };
    const tick = service.tick();
    await new Promise((r) => setImmediate(r));
    const paused = service.scan(m.id, "pause");
    release({ result: {} });
    await tick;
    await paused;
    assert.equal(moves, 0);
    assert.ok(stops > 0);
    assert.equal(service.active.status.state, "paused");
  } finally {
    clearTimeout(service.timer);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Stop during scan preparation cancels the pending start", async () => {
  const dir = await mkdtemp(tmpdir() + "/alfred-start-test-");
  let release;
  const points = Array.from({ length: 180 }, (_, i) => ({
    x: 2000 * Math.cos((i * Math.PI) / 90),
    y: 2000 * Math.sin((i * Math.PI) / 90),
  }));
  const service = new MapService(
    {
      stop: async () => {},
      lidar: () =>
        new Promise((r) => {
          release = r;
        }),
    },
    dir,
  );
  try {
    const m = await service.create({ name: "Cancel start" });
    const start = service.scan(m.id, "start", {backend:"experimental"});
    await new Promise((r) => setTimeout(r, 10));
    await service.pauseActive();
    release({
      result: { sequence: 1, observed_at_unix_ms: Date.now(), points },
    });
    await assert.rejects(start, /cancelled/);
    assert.equal(service.active, null);
  } finally {
    clearTimeout(service.timer);
    await rm(dir, { recursive: true, force: true });
  }
});

test("keyframes anchor a scan returning to its starting position", () => {
  const world = [];
  for (let i = 0; i < 150; i++)
    world.push([i * 0.025 - 1, 2], [3, i * 0.025 - 1], [-1, i * 0.025 - 1]);
  const scanner = new Scanner();
  let sequence = 0;
  for (const x of [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.32, 0.24, 0.16, 0.08, 0]) {
    const pose = { x, y: 0, theta: x * 0.1 },
      c = Math.cos(pose.theta),
      s = Math.sin(pose.theta);
    const points = world.map(([X, Y]) => ({
      x: ((X - x) * c + Y * s) * 1000,
      y: (-(X - x) * s + Y * c) * 1000,
    }));
    scanner.ingest({
      sequence: sequence++,
      observed_at_unix_ms: Date.now(),
      points,
    });
  }
  assert.ok(Math.hypot(scanner.pose.x, scanner.pose.y) < 0.06);
  assert.ok(Math.abs(scanner.pose.theta) < 0.03);
  assert.ok(scanner.keyframes.length >= 2);
});

test('saved-map localization recovers a moved and rotated robot; rejects unrelated scenes', async () => {
  const {locate,inverse}=await import('../src/maps/localization.mjs');
  const world=[];
  for(let i=0;i<100;i++)world.push([-2+i*.05,-2]);
  for(let i=0;i<100;i++)world.push([3,-2+i*.05]);
  for(let i=0;i<100;i++)world.push([-2,-2+i*.034]);
  for(let i=0;i<100;i++)world.push([-2+i*.05,2+i*.01]);
  for(let i=0;i<100;i++)world.push([1.8+.3*Math.cos(i*Math.PI/50),1.3+.3*Math.sin(i*Math.PI/50)]);
  const s=new Scanner();
  const scan=(points,sequence)=>({sequence,observed_at_unix_ms:Date.now(),points:points.map(([x,y])=>({x:x*1000,y:y*1000}))});
  s.ingest(scan(world,1));
  const pose={x:.8,y:.4,theta:1.13};
  const found=locate(scan(transform(world,inverse(pose)),2),s.checkpoint());
  assert.ok(Math.hypot(found.pose.x-pose.x,found.pose.y-pose.y)<.06,JSON.stringify(found));
  assert.ok(Math.abs(found.pose.theta-pose.theta)<.03);
  assert.throws(()=>locate(scan(world.map(([x,y])=>[x*3,y*3]),3),s.checkpoint()),/not recognized/);
});

test('loop closure corrects the trajectory and rebuilds cells; checkpoint preserves graph', async () => {
  const {relative,inverse}=await import('../src/maps/localization.mjs');
  const s=new Scanner(),world=[];
  for(let i=0;i<100;i++)world.push([-2+i*.05,-2],[3,-2+i*.05],[-2,-2+i*.04]);
  for(let i=0;i<=16;i++) {
    const t=i/16*Math.PI*2;
    const actual={x:1.2*(1-Math.cos(t)),y:Math.sin(t),theta:0};
    const pose={...actual,x:actual.x+i*.006,y:actual.y+i*.002};
    const local=transform(world,inverse(actual));
    s.keyframes.push({pose,local,points:transform(local,pose)});
    if(i)s.edges.push({a:i-1,b:i,delta:relative(s.keyframes[i-1].pose,pose)});
  }
  s.pose={...s.keyframes.at(-1).pose};
  const before=Math.hypot(s.pose.x,s.pose.y);
  assert.equal(s.closeLoop(),true);
  assert.ok(Math.hypot(s.pose.x,s.pose.y)<before*.6,JSON.stringify(s.pose));
  assert.equal(s.loopClosures,1);
  assert.ok(s.cells.size>100);
  s.reference=world;
  const recovered=Scanner.restore(s.checkpoint());
  assert.equal(recovered.loopClosures,1);
  assert.equal(recovered.edges.at(-1).loop,true);
  assert.deepEqual(recovered.pose,s.pose);
});

test('deleting an active map stops motion and removes it from the library',async()=>{
  const dir=await mkdtemp(tmpdir()+'/alfred-delete-test-');let stopped=0;
  try {
    const service=new MapService({stop:async()=>stopped++},dir);
    service.navigation={call:async()=>({})};
    const map=await service.create({name:'Delete me'});
    service.active={id:map.id,status:{state:'scanning'}};
    await service.remove(map.id);
    assert.equal(stopped,1);assert.equal(service.active,null);
    assert.deepEqual(await service.list(),[]);
    await assert.rejects(service.get(map.id));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('rotationally symmetric reference is rejected instead of choosing an arbitrary heading', async()=>{
  const {locate}=await import('../src/maps/localization.mjs');
  const scan={sequence:1,observed_at_unix_ms:Date.now(),points:Array.from({length:720},(_,i)=>({x:2000*Math.cos(i*Math.PI/360),y:2000*Math.sin(i*Math.PI/360)}))};
  const s=new Scanner();s.ingest(scan);
  assert.throws(()=>locate(scan,s.checkpoint()),/ambiguous/);
});

test('resume uses the saved reference and verifies a second live scan before motion',async()=>{
  const {inverse}=await import('../src/maps/localization.mjs');
  const dir=await mkdtemp(tmpdir()+'/alfred-relocate-test-');
  const world=[];
  for(let i=0;i<120;i++)world.push([-2+i*.04,-2]);
  for(let i=0;i<120;i++)world.push([3,-2+i*.04]);
  for(let i=0;i<120;i++)world.push([-2,-2+i*.025]);
  for(let i=0;i<120;i++)world.push([-2+i*.04,2+i*.008]);
  let pose={x:0,y:0,theta:0},sequence=0,commands=0;
  const engine={stop:async()=>{},mappingDrive:async()=>commands++,lidar:async()=>({result:{sequence:++sequence,observed_at_unix_ms:Date.now(),points:transform(world,inverse(pose)).map(([x,y])=>({x:x*1000,y:y*1000}))}})};
  const service=new MapService(engine,dir);
  try {
    const map=await service.create({name:'Reference'});
    await service.scan(map.id,'start',{backend:'experimental'});await service.scan(map.id,'pause');
    pose={x:.7,y:-.4,theta:1.1};
    const located=await service.scan(map.id,'locate');
    assert.equal(located.scan.state,'paused');
    assert.equal(located.scan.localization,'located');
    assert.ok(Math.hypot(located.scan.pose.x-pose.x,located.scan.pose.y-pose.y)<.06);
    assert.equal(commands,0);
  }finally{clearTimeout(service.timer);await rm(dir,{recursive:true,force:true});}
});

test('floor plan straightens noisy walls without bridging a doorway',async()=>{
 const {wallSegments}=await import('../src/maps/walls.mjs');
 const cells=[];
 for(let x=0;x<=100;x++)if(x<40||x>60)cells.push([x,Math.round(Math.sin(x)*.7),8]);
 for(let y=0;y<=70;y++)cells.push([Math.round(Math.sin(y)*.7),y,8]);
 const walls=wallSegments(cells);
 assert.ok(walls.length>=3);
 for(const [a,b] of walls) {
   assert.ok(Math.abs(a[0]-b[0])<.12 || Math.abs(a[1]-b[1])<.12);
   if(Math.abs(a[1])<.15 && Math.abs(b[1])<.15)assert.ok(!(Math.min(a[0],b[0])<2 && Math.max(a[0],b[0])>3));
 }
});
