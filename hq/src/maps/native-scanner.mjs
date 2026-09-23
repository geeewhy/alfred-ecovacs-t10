// Adapter for firmware SLAM. Does not estimate poses or alter native geometry.
export class NativeScanner {
  constructor(checkpoint = null) {
    this.nativeSnapshot=checkpoint?.nativeSnapshot;this.backend = 'native'; this.bootId=checkpoint?.bootId; this.frames = checkpoint?.frames || 0;
    this.pose = checkpoint?.pose || {x:0,y:0,theta:0};
    this.nativeGrid = checkpoint?.nativeGrid || null;
    this.keyframes = checkpoint?.keyframes || [];
    this.trajectory = checkpoint?.trajectory || [];
    this.lastSequence = null; this.cells = checkpoint?.cells || [];
  }
  update(grid, status, scan) {
    if (status.pose.age_ms == null || status.pose.age_ms > 500) throw Error('Waiting for fresh native position.');
    this.bootId=status.boot_id;
    this.pose = {x:status.pose.x,y:status.pose.y,theta:status.pose.theta};
    if (grid && grid.sequence !== this.nativeGrid?.sequence) {
      if (Math.abs(grid.resolution-.05)>.0001) throw Error('Unsupported native map resolution.');
      this.nativeGrid = grid;
      const ox=Math.round(grid.origin[0]/grid.resolution),oy=Math.round(grid.origin[1]/grid.resolution);
      this.cells=grid.cells.map(([x,y,v])=>[x+ox,y+oy,v<=127?-Math.min(8,v/16):Math.min(8,(256-v)/16)]);
    }
    if(scan.sequence!==this.lastSequence){
      this.lastSequence=scan.sequence;this.frames++;
      const last=this.trajectory.at(-1);
      if(!last || Math.hypot(last.x-this.pose.x,last.y-this.pose.y)>.025 || Math.abs(last.theta-this.pose.theta)>.08){
        this.trajectory.push({...this.pose});
        if(this.trajectory.length>10000)this.trajectory.splice(0,1000);
      }
      const previous=this.keyframes.at(-1)?.pose;
      if(this.recordKeyframes!==false && (!previous || Math.hypot(previous.x-this.pose.x,previous.y-this.pose.y)>.2)){
        const c=Math.cos(this.pose.theta),s=Math.sin(this.pose.theta);
        const points=scan.points.filter(p=>p.power>0).map(p=>[this.pose.x+(p.x*c-p.y*s)/1000,this.pose.y+(p.x*s+p.y*c)/1000]);
        this.keyframes.push({pose:{...this.pose},points});
        if(this.keyframes.length>1500)this.keyframes.shift();
      }
    }
    return {backend:'native',pose:this.pose,frames:this.frames,localization:'tracking',trajectory:this.trajectory};
  }
  grid(){return this.cells;}
  checkpoint(){return {backend:'native',nativeSnapshot:this.nativeSnapshot,bootId:this.bootId,pose:this.pose,frames:this.frames,nativeGrid:this.nativeGrid,cells:this.cells,keyframes:this.keyframes,trajectory:this.trajectory};}
}
export class NavigationClient {
  constructor(base='http://127.0.0.1:48766'){this.base=base;}
  async call(action,body={}){
    const response=await fetch(`${this.base}/${action}${action==="structure" && body.sequence ? "?sequence="+encodeURIComponent(body.sequence) : ""}`,{method:['status','grid','structure'].includes(action)?'GET':'POST',headers:{'content-type':'application/json'},body:['status','grid','structure'].includes(action)?undefined:JSON.stringify(body),signal:AbortSignal.timeout(action.startsWith('mapping/')?10000:['settings','structure'].includes(action)?5000:1500)});
    const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'Navigation service unavailable');return value.result;
  }
}

export class GraphScanner extends NativeScanner {
 constructor(checkpoint){super(checkpoint);this.backend='slam_toolbox';this.structuralSnapshot=null;this.recordKeyframes=false;this.keyframes=[];}
 acceptStructure(snapshot){
  if(!snapshot || snapshot.sequence===this.structuralSnapshot?.sequence)return;
  const grid=snapshot.grid;
  if(Math.abs(grid.resolution-.05)>.0001)throw Error("Unsupported structural map resolution.");
  const ox=Math.round(grid.origin[0]/grid.resolution),oy=Math.round(grid.origin[1]/grid.resolution);
  this.trajectory=snapshot.keyframes.map(frame=>({...frame.pose}));
  this.structuralSnapshot={sequence:snapshot.sequence,keyframes:snapshot.keyframes,cells:grid.cells.map(([x,y,v])=>[x+ox,y+oy,v<=127?-Math.min(8,v/16):Math.min(8,(256-v)/16)])};
 }

 update(grid,status,scan){return {...super.update(grid,status,scan),backend:this.backend};}
 checkpoint(){return {...super.checkpoint(),backend:this.backend,nativeSnapshot:undefined,keyframes:undefined};}
}
