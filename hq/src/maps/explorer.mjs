import { scanAge } from "./freshness.mjs";
import { supportedWalls } from "./walls.mjs";
const STEP = 0.05;
const key = (x, y) => `${x},${y}`;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Continuous occupied runs guide wall avoidance. Isolated close returns do
// not veto motion; bumpers trigger contact recovery.
export function frontierPath(cells, pose, visits = new Map(), keyframes = [], contactPoints = []) {
  const free = new Set(cells.map(([x,y])=>key(x,y)));
  const blocked=new Set();
  for(const [a,b] of supportedWalls(cells, keyframes)) {
    const steps=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/STEP);
    for(let i=0;i<=steps;i++) {
      const x=Math.floor((a[0]+(b[0]-a[0])*i/steps)/STEP),y=Math.floor((a[1]+(b[1]-a[1])*i/steps)/STEP);
      blocked.add(key(x,y));
      for(let dx=-4;dx<=4;dx++)for(let dy=-4;dy<=4;dy++) {
        const X=x+dx,Y=y+dy;
        if(Math.hypot((X+.5)*STEP-pose.x,(Y+.5)*STEP-pose.y)<.24)continue;
        if(Math.hypot(dx,dy)*STEP<=.2)blocked.add(key(X,Y));
      }
    }
  }
  for(const p of contactPoints) {
    const x=Math.floor(p[0]/STEP),y=Math.floor(p[1]/STEP);
    for(let dx=-5;dx<=5;dx++)for(let dy=-5;dy<=5;dy++)if(Math.hypot(dx,dy)*STEP<=.24)blocked.add(key(x+dx,y+dy));
  }
  const sx = Math.floor(pose.x / STEP),
    sy = Math.floor(pose.y / STEP),
    start = key(sx, sy),
    queue = [[sx, sy]],
    parents = new Map([[start, null]]),
    distance = new Map([[start, 0]]);
  let best = null,
    bestScore = -Infinity;
  for (let i = 0; i < queue.length && i < 50000; i++) {
    const [x, y] = queue[i],
      k = key(x, y),
      d = distance.get(k);
    let unknown = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = key(x + dx, y + dy);
      if (!free.has(n) && !blocked.has(n)) unknown++;
      if (free.has(n) && !blocked.has(n) && !parents.has(n)) {
        parents.set(n, k);
        distance.set(n, d + 1);
        queue.push([x + dx, y + dy]);
      }
    }
    if (unknown && d >= 12 && !blocked.has(k)) {
      const heading = Math.abs(wrap(Math.atan2((y+.5)*STEP-pose.y,(x+.5)*STEP-pose.x)-(pose.theta||0)));
      const score = unknown * 3 - Math.log1p(d) * 2 - (visits.get(k) || 0) * 4 - heading*1.5;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
  }
  if (!best) {
    // Sparse coverage can need a short probing move, but never through a wall.
    if(queue.length<32) {
      for(const offset of [0,Math.PI/4,-Math.PI/4,Math.PI/2,-Math.PI/2,Math.PI]) {
        const theta=(pose.theta||0)+offset;
        const path=Array.from({length:15},(_,i)=>[pose.x+i*STEP*Math.cos(theta),pose.y+i*STEP*Math.sin(theta)]);
        if(path.every(([x,y])=>!blocked.has(key(Math.floor(x/STEP),Math.floor(y/STEP)))))return {path,key:null};
      }
    }
    return {path:[],blocked:queue.length<32,key:null};
  }
  const route = [];
  for (let k = best; k; k = parents.get(k)) {
    const [x, y] = k.split(",").map(Number);
    route.push([(x + 0.5) * STEP, (y + 0.5) * STEP]);
  }
  return { path: route.reverse(), key: best };
}

export class Explorer {
  constructor(minutes = 10, saved = {}) {
    this.deadline = Date.now() + minutes * 60000;
    this.visits = new Map(saved.visits || []);
    this.plan = null;
    this.lastPlan = 0;
    this.noFrontier = 0;
    this.history = [];
    this.recovery = saved.recovery ? {...saved.recovery,started:Date.now()} : null;
    this.contactPoints = saved.contactPoints || [];
    this.contacts = saved.contacts || [];
    this.lastTurn = -1;
  }
  checkpoint() { return {visits:[...this.visits],contactPoints:this.contactPoints,contacts:this.contacts,recovery:this.recovery}; }
  step(scanner, scan, sensors) {
    if (
      !sensors?.fresh ||
      sensors.cliff_raw !== 0 ||
      sensors.wheel_lift_raw !== 0
    )
      throw Error("Cliff/lift sensors are unavailable or triggered.");
    if(typeof sensors.left !== "boolean" || typeof sensors.right !== "boolean")
      throw Error("Bumper sensors are unavailable.");
    if (scanAge(scan) > 750)
      throw Error("LiDAR is stale.");
    if (Date.now() > this.deadline)
      return { done: true, message: "Scan time limit reached." };
    const pose = scanner.pose;
    const now=Date.now(), pressed=sensors.left || sensors.right;
    if(pressed && (!this.recovery || this.recovery.phase==="advance")) {
      this.contacts=this.contacts.filter(t=>now-t<30000);
      if(this.contacts.length>=6)throw Error("Repeated bumper contacts. Exploration paused.");
      this.contacts.push(now);
      const turn=sensors.left && !sensors.right ? .55 : sensors.right && !sensors.left ? -.55 : -this.lastTurn*.55;
      this.lastTurn=Math.sign(turn);
      this.contactPoints.push([pose.x+.18*Math.cos(pose.theta),pose.y+.18*Math.sin(pose.theta)]);
      this.contactPoints=this.contactPoints.slice(-100);
      this.recovery={phase:"back",started:now,turn,target:wrap(pose.theta-Math.sign(turn)*Math.PI/2)};
      if(this.plan?.key)this.visits.set(this.plan.key,(this.visits.get(this.plan.key)||0)+5);
      this.plan=null;this.history=[];
      return {linear:0,angular:0,message:"Bumper contact; stopping."};
    }
    if(this.recovery) {
      const r=this.recovery,elapsed=now-r.started;
      if(r.phase==="back") {
        if(elapsed>1200 && pressed)throw Error("Bumper did not release after backing away. Exploration paused.");
        if(elapsed<700 || pressed)return {linear:-.25,angular:0,message:"Backing away from bumper contact"};
        r.phase="turn";r.started=now;
      }
      if(r.phase==="turn") {
        if(pressed)throw Error("Bumper pressed during recovery turn. Exploration paused.");
        const remaining=wrap(r.target-pose.theta);
        if(Math.abs(remaining)>.12) {
          if(now-r.started>10000)throw Error("Recovery turn made insufficient progress. Exploration paused.");
          return {linear:0,angular:Math.max(-.65,Math.min(.65,-remaining)),message:r.turn>0?"Maneuvering right":"Maneuvering left"};
        }
        r.phase="advance";r.started=now;r.origin=[pose.x,pose.y];
      }
      if(r.phase==="advance") {
        if(Math.hypot(pose.x-r.origin[0],pose.y-r.origin[1])<.18 && now-r.started<5000)return {linear:.35,angular:0,message:"Moving clear of contact"};
        this.recovery=null;this.plan=null;
        return {linear:0,angular:0,message:"Contact cleared; resuming exploration"};
      }
    }
    if (Math.abs(pose.x) > 28 || Math.abs(pose.y) > 28)
      return { done: true, message: "Map boundary reached." };
    if (!this.plan?.path?.length) {
      this.lastPlan = Date.now();
      this.plan = frontierPath(scanner.grid(), pose, this.visits, scanner.keyframes, this.contactPoints);
      if (!this.plan?.path?.length) {
        if (this.plan?.blocked) {
          throw Error("No route around mapped walls. Exploration paused.");
        } else {
        this.noFrontier++;
        if (this.noFrontier >= 3)
          return {
            done: true,
            message: "No reachable unexplored boundary remains.",
          };
        return { linear: 0, angular: 0, message: "Checking coverage…" };
        }
      }
      this.noFrontier = 0;
    }
    const goal = this.plan.path.at(-1);
    if (Math.hypot(goal[0] - pose.x, goal[1] - pose.y) < 0.28) {
      this.visits.set(this.plan.key, (this.visits.get(this.plan.key) || 0) + 1);
      this.plan = null;
      return { linear: 0, angular: 0, message: "Choosing next boundary…" };
    }
    let closest = 0;
    for (let i = 1; i < this.plan.path.length; i++)
      if (
        Math.hypot(
          this.plan.path[i][0] - pose.x,
          this.plan.path[i][1] - pose.y,
        ) <
        Math.hypot(
          this.plan.path[closest][0] - pose.x,
          this.plan.path[closest][1] - pose.y,
        )
      )
        closest = i;
    const waypoint =
      this.plan.path
        .slice(closest)
        .find((p) => Math.hypot(p[0] - pose.x, p[1] - pose.y) > 0.35) || goal;
    const angle = wrap(
      Math.atan2(waypoint[1] - pose.y, waypoint[0] - pose.x) - pose.theta,
    );
    // Engine positive yaw turns right; map theta decreases.
    const angular = Math.max(-0.65, Math.min(0.65, -angle * 1.4));
    const linear = Math.abs(angle)>0.28 ? 0 : .5;
    this.history.push({
      at: Date.now(),
      x: pose.x,
      y: pose.y,
      theta: pose.theta,
      moving: linear > 0.1 || Math.abs(angular) > 0.1,
    });
    this.history = this.history.filter((h) => Date.now() - h.at < 10000);
    const oldest = this.history[0];
    if (
      Date.now() - oldest.at > 8000 &&
      this.history.every((h) => h.moving) &&
      Math.hypot(pose.x - oldest.x, pose.y - oldest.y) < 0.035 &&
      Math.abs(wrap(pose.theta - oldest.theta)) < 0.05
    )
      throw Error(
        "No movement detected. Check for an obstruction before resuming.",
      );
    return {
      linear,
      angular: linear ? angular * 0.25 : angular,
      message: linear ? "Exploring" : "Turning toward unexplored space",
      goal,
      path: this.plan.path,
    };
  }
}
