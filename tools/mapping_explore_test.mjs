// Bounded supervised run, with continuous LiDAR recording and stop in finally.
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:4173/api/maps';
async function api(path='',body) {
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 const d=await r.json();if(!d.ok)throw Error(d.error);return d.result;
}
const mapId=process.argv.slice(2).find(v=>!v.startsWith('--'));
const m=mapId?await api('/'+mapId):await api('',{name:'Mapping validation'});
const seconds=Number(process.argv.find(v=>v.startsWith('--seconds='))?.split('=')[1]||5);
if(!Number.isFinite(seconds)||seconds<1||seconds>900)throw Error('Use 1–900 seconds per run');
const samples=[];let final,startedScan=false;
const known=new Set(m.cells.map(([x,y])=>`${x},${y}`));
const initialFrames=m.scan.frames||0;
const reportEvery=seconds>60?5000:1000;
const cruise=Number(process.argv.find(v=>v.startsWith('--cruise='))?.split('=')[1]||0);
console.log('map',m.id);
try {
 if(cruise){
  const r=await fetch(base+'/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({cruise_mm_s:cruise,approach_mm_s:Math.min(80,cruise)}),signal:AbortSignal.timeout(10000)});
  const d=await r.json();if(!d.ok)throw Error(d.error);console.log('speeds',JSON.stringify(d.result));
 }
 if(process.argv.includes('--backend'))await fetch('http://127.0.0.1:48765/v1/mapping/native/backend-start',{method:'POST',signal:AbortSignal.timeout(1500)});
 await api('/'+m.id+'/scan',{action:mapId?'resume':'start',mode:'explore',minutes:Math.min(60,Math.ceil(seconds/60)+1)});
 startedScan=true;
 const started=Date.now();let report=started;
 while(Date.now()-started<seconds*1000) {
  const r=await fetch('http://127.0.0.1:48765/v1/telemetry/lidar',{signal:AbortSignal.timeout(1000)}),d=await r.json();
  if(d.ok && d.result.sequence!==samples.at(-1)?.sequence) {
   const sensors=await fetch("http://127.0.0.1:48765/v1/telemetry/bumpers",{signal:AbortSignal.timeout(1000)}).then(r=>r.json());
   const navigation=await fetch("http://127.0.0.1:48766/status",{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).catch(()=>null);
   const native=await fetch("http://127.0.0.1:48765/v1/mapping/native/status",{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).catch(()=>null);
   samples.push({...d.result,sensors:sensors.result,navigation,native:native?.result});
  }
  if(Date.now()>=report) {
   final=await api('/'+m.id);
   console.log(JSON.stringify({state:final.scan.state,message:final.scan.message,pose:final.scan.pose,frames:final.scan.frames,sensors:final.scan.sensors,walls:final.vectors.length,newScans:final.scan.frames-initialFrames,knownAreaM2:+(final.cells.length*final.resolution**2).toFixed(2),newObservedAreaM2:+(final.cells.filter(([x,y])=>!known.has(`${x},${y}`)).length*final.resolution**2).toFixed(2)}));
   if(final.scan.state!=='scanning')break;
   report=Date.now()+reportEvery;
  }
  await new Promise(r=>setTimeout(r,100));
 }
}catch(error){console.error('TEST ERROR:',error.message);process.exitCode=1;}
finally {
 if(process.argv.includes('--backend'))await fetch('http://127.0.0.1:48765/v1/mapping/native/backend-off',{method:'POST',signal:AbortSignal.timeout(1500)}).catch(()=>{});
 try{
  if(!startedScan) { final=await api('/'+m.id); }
  else if(final?.scan?.state==='finished' || final?.scan?.state==='paused') {
   await fetch('http://127.0.0.1:48765/v1/drive/stop',{method:'POST',signal:AbortSignal.timeout(1500)});
  } else final=await api('/'+m.id+'/scan',{action:'pause'});
  console.log('stopped',JSON.stringify({state:final.scan.state,pose:final.scan.pose,frames:final.scan.frames,error:final.scan.error}));
 }
 catch(error){console.error('PAUSE:',error.message);await fetch('http://127.0.0.1:48765/v1/drive/stop',{method:'POST',signal:AbortSignal.timeout(1000)}).catch(()=>{});}
 const directory=new URL('../artifacts/hq/mapping-runs/',import.meta.url);await mkdir(directory,{recursive:true});
 const file=new URL(`${Date.now()}-explore.json`,directory);await writeFile(file,JSON.stringify({map:m.id,samples,scan:final?.scan}));
 console.log('recording',file.pathname,'samples',samples.length);
}
