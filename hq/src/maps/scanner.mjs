import { scanAge } from "./freshness.mjs";
import { relative, compose, inverse, optimizeGraph, localPoints } from "./localization.mjs";
// Measured LiDAR only. Units at the engine boundary are millimetres.
export function transform(points, p) {
  const c = Math.cos(p.theta),
    s = Math.sin(p.theta);
  return points.map(([x, y]) => [c * x - s * y + p.x, s * x + c * y + p.y]);
}
export function align(points, reference, initial = { x: 0, y: 0, theta: 0 }) {
  const buckets = new Map();
  for (const q of reference) {
    const k = `${Math.floor(q[0]/.35)},${Math.floor(q[1]/.35)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(q);
  }
  let pose = { ...initial },
    rms = Infinity,
    coverage = 0;
  for (let step = 0; step < 18; step++) {
    const source = transform(points, pose),
      pairs = [];
    for (const p of source) {
      let best = null,
        d = 0.35 ** 2;
      const X=Math.floor(p[0]/.35),Y=Math.floor(p[1]/.35);
      const nearby=[];
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)nearby.push(...(buckets.get(`${X+dx},${Y+dy}`)||[]));
      for (const q of nearby) {
        const n = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
        if (n < d) {
          d = n;
          best = q;
        }
      }
      if (best) pairs.push([p, best, d]);
    }
    pairs.sort((a, b) => a[2] - b[2]);
    coverage = pairs.length / points.length;
    const kept = pairs.slice(0, Math.ceil(pairs.length * 0.85));
    if (kept.length < 30) return { ok: false, pose, rms, coverage };
    const mean = (side) =>
      kept.reduce(
        (s, p) => [
          s[0] + p[side][0] / kept.length,
          s[1] + p[side][1] / kept.length,
        ],
        [0, 0],
      );
    const a = mean(0),
      b = mean(1);
    let dot = 0,
      cross = 0;
    for (const [p, q] of kept) {
      const x = p[0] - a[0],
        y = p[1] - a[1],
        u = q[0] - b[0],
        v = q[1] - b[1];
      dot += x * u + y * v;
      cross += x * v - y * u;
    }
    const angle = Math.atan2(cross, dot),
      c = Math.cos(angle),
      s = Math.sin(angle),
      tx = b[0] - c * a[0] + s * a[1],
      ty = b[1] - s * a[0] - c * a[1];
    pose = {
      x: c * pose.x - s * pose.y + tx,
      y: s * pose.x + c * pose.y + ty,
      theta: pose.theta + angle,
    };
    rms = Math.sqrt(kept.reduce((s, p) => s + p[2], 0) / kept.length);
    if (Math.hypot(tx, ty) < 0.0005 && Math.abs(angle) < 0.0005) break;
  }
  return {
    ok:
      coverage > 0.65 &&
      rms < 0.09 &&
      Math.hypot(pose.x - initial.x, pose.y - initial.y) < 0.3 &&
      Math.abs(pose.theta - initial.theta) < 0.3,
    pose,
    rms,
    coverage,
  };
}
export class Scanner {
  constructor() {
    this.pose = { x: 0, y: 0, theta: 0 };
    this.reference = null;
    this.cells = new Map();
    this.frames = 0;
    this.lastSequence = null;
    this.keyframes = [];
    this.edges = [];
    this.loopClosures = 0;
    this.lastLoopFrame = -20;
  }
  static restore(state) {
    const scanner = new Scanner();
    if (!state?.pose || !Array.isArray(state.reference))
      throw Error("This older scan cannot be resumed; create a new map.");
    scanner.pose = state.pose;
    scanner.reference = state.reference;
    scanner.keyframes = state.keyframes || [
      { pose: state.pose, points: state.reference },
    ];
    scanner.edges = state.edges || scanner.keyframes.slice(1).map((f,i)=>({a:i,b:i+1,delta:relative(scanner.keyframes[i].pose,f.pose)}));
    for (const f of scanner.keyframes) f.local ||= transform(f.points, inverse(f.pose));
    scanner.loopClosures = state.loopClosures || 0;
    scanner.lastLoopFrame = state.lastLoopFrame ?? -20;
    scanner.frames = state.frames || 0;
    scanner.cells = new Map(
      (state.cells || []).map(([x, y, v]) => [`${x},${y}`, v]),
    );
    return scanner;
  }
  checkpoint() {
    return {
      pose: this.pose,
      reference: this.reference,
      keyframes: this.keyframes,
      edges: this.edges,
      loopClosures: this.loopClosures,
      lastLoopFrame: this.lastLoopFrame,
      frames: this.frames,
      cells: this.grid(),
    };
  }
  ingest(scan) {
    if (
      !scan ||
      !Number.isFinite(scan.observed_at_unix_ms) ||
      scanAge(scan) > 1500 ||
      scan.sequence === this.lastSequence
    )
      throw Error("Waiting for fresh LiDAR.");
    const points = localPoints(scan);
    if (points.length < 60) throw Error("Not enough LiDAR returns.");
    this.lastSequence = scan.sequence;
    let quality = { rms: 0, coverage: 1 };
    if (this.reference) {
      quality = align(points, this.reference, this.pose);
      if (!quality.ok)
        throw Error(
          "Alignment lost. Stop moving; return to the last mapped position or start a new scan.",
        );
      this.pose = quality.pose;
    }
    let world = transform(points, this.pose);
    const previous = this.keyframes.at(-1)?.pose;
    if (
      !previous ||
      Math.hypot(this.pose.x - previous.x, this.pose.y - previous.y) > 0.3 ||
      Math.abs(this.pose.theta - previous.theta) > 0.3
    ) {
      if (this.keyframes.length >= 1500) throw Error("Map capacity reached. Finish this map before starting another.");
      const n=this.keyframes.length;
      this.keyframes.push({ pose: { ...this.pose }, points: world, local: points });
      if(n) this.edges.push({a:n-1,b:n,delta:relative(this.keyframes[n-1].pose,this.pose)});
      if(this.closeLoop()) world=transform(points,this.pose);
    }
    // Match against nearby retained keyframes instead of letting every noisy
    // stationary frame become the next coordinate reference.
    const near = [...this.keyframes]
      .sort(
        (a, b) =>
          Math.hypot(a.pose.x - this.pose.x, a.pose.y - this.pose.y) -
          Math.hypot(b.pose.x - this.pose.x, b.pose.y - this.pose.y),
      )
      .slice(0, 4);
    const voxels = new Map();
    for (const frame of near)
      for (const p of frame.points) {
        const key = `${Math.floor(p[0] / 0.07)},${Math.floor(p[1] / 0.07)}`;
        if (!voxels.has(key)) voxels.set(key, p);
      }
    this.reference = [...voxels.values()].slice(0, 1400);
    this.frames++;
    this.integrate(world, this.pose);
    return {
      frames: this.frames,
      loopClosures: this.loopClosures,
      pose: this.pose,
      rms: quality.rms,
      coverage: quality.coverage,
    };
  }
  closeLoop() {
    const n=this.keyframes.length-1;
    if(n<12 || n-this.lastLoopFrame<8) return false;
    const current=this.keyframes[n];
    const candidates=this.keyframes.slice(0,n-10).map((f,i)=>({f,i,d:Math.hypot(f.pose.x-current.pose.x,f.pose.y-current.pose.y)})).filter(c=>c.d<1.2).sort((a,b)=>a.d-b.d).slice(0,4);
    let best;
    for(const c of candidates) {
      // A revisit must include a real excursion, not stationary sensor noise.
      if(!this.keyframes.slice(c.i+1,n).some(f=>Math.hypot(f.pose.x-c.f.pose.x,f.pose.y-c.f.pose.y)>1.5))continue;
      const fit=align(current.local,c.f.points,current.pose);
      if(!fit.ok || fit.coverage<.85 || fit.rms>.035)continue;
      // Verify the reverse registration too, to reject incidental partial overlap.
      const reverse=align(c.f.local,transform(current.local,fit.pose),c.f.pose);
      if(!reverse.ok || reverse.coverage<.85 || reverse.rms>.035)continue;
      if(!best || fit.rms<best.fit.rms)best={...c,fit};
    }
    if(!best)return false;
    this.edges.push({a:best.i,b:n,delta:relative(best.f.pose,best.fit.pose),loop:true});
    const corrected=optimizeGraph(this.keyframes,this.edges);
    this.cells.clear();
    this.keyframes.forEach((f,i)=>{f.pose=corrected[i];f.points=transform(f.local,f.pose);this.integrate(f.points,f.pose);});
    this.pose={...corrected[n]};
    this.loopClosures++;
    this.lastLoopFrame=n;
    return true;
  }
  integrate(world, pose) {
    const mark = (x, y, n) => {
      if (Math.abs(x) > 600 || Math.abs(y) > 600) return;
      const k = `${x},${y}`;
      this.cells.set(
        k,
        Math.max(-8, Math.min(8, (this.cells.get(k) || 0) + n)),
      );
    };
    const free = new Set(),
      occupied = new Set();
    for (const [x, y] of world) {
      const dx = x - pose.x,
        dy = y - pose.y,
        steps = Math.ceil(Math.hypot(dx, dy) / 0.05);
      for (let i = 0; i < steps - 1; i++)
        free.add(
          `${Math.floor((pose.x + (dx * i) / steps) / 0.05)},${Math.floor((pose.y + (dy * i) / steps) / 0.05)}`,
        );
      occupied.add(`${Math.floor(x / 0.05)},${Math.floor(y / 0.05)}`);
    }
    for (const key of free)
      if (!occupied.has(key)) {
        const [x, y] = key.split(",").map(Number);
        mark(x, y, -1);
      }
    for (const key of occupied) {
      const [x, y] = key.split(",").map(Number);
      mark(x, y, 3);
    }
  }
  grid() {
    return [...this.cells].map(([k, v]) => [...k.split(",").map(Number), v]);
  }
}
export function outlines(cells) {
  const occupied = new Set(
      cells.filter((c) => c[2] >= 2).map((c) => `${c[0]},${c[1]}`),
    ),
    lines = [];
  for (const key of occupied) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy, a, b] of [
      [0, -1, [x, y], [x + 1, y]],
      [1, 0, [x + 1, y], [x + 1, y + 1]],
      [0, 1, [x + 1, y + 1], [x, y + 1]],
      [-1, 0, [x, y + 1], [x, y]],
    ])
      if (!occupied.has(`${x + dx},${y + dy}`))
        lines.push([a.map((n) => n * 0.05), b.map((n) => n * 0.05)]);
  }
  return lines;
}
