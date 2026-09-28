// Bounded physical calibration. Records sensors; does not infer ground truth
// from a custom mapper. Compare wheel distance against an actual floor mark.
import {mkdir,writeFile} from 'node:fs/promises';
import {stoppedWindow} from './mapping_motion_evidence.mjs';
const args=process.argv.slice(2),mode=args.find(a=>!a.startsWith('--'))||'forward';
const number=(key,fallback)=>Number(args.find(a=>a.startsWith(`--${key}=`))?.split('=')[1]??fallback);
const speed=number('speed',120),seconds=number('seconds',2),yaw=number('yaw',.35);
const undock=args.includes('--undock');
if(undock&&(mode!=='forward'||speed>120||seconds>2))throw Error('Undock probe requires forward motion, at most 120 mm/s for 2 seconds');
if(!['forward','turn'].includes(mode)||![speed,seconds,yaw].every(Number.isFinite)||speed<=0||seconds<=0||seconds>15||yaw===0)throw Error('Use forward/turn, --speed=mm/s, --yaw=rad/s, --seconds=1–15');
if(args.includes('--help')){console.log('node tools/mapping_motion_test.mjs forward --speed=120 --seconds=2\nnode tools/mapping_motion_test.mjs turn --yaw=0.35 --seconds=2');process.exit(0);}
const engine='http://127.0.0.1:48765';
async function call(url,body,method){
 const response=await fetch(url,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(url.includes('/api/maps/')?5000:1500)});
 const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||value.result||'Robot request failed');return value.result;
}
const samples=[],commands=[];let error,settled=false;const stopSamples=[];
try{
 await call('http://127.0.0.1:4173/api/maps/active/pause',{});
 const battery=await call(engine+'/v1/telemetry/battery');
 if(battery.percent==null||battery.percent<=10||battery.low_voltage||(battery.on_charger&&!undock))throw Error('Charge Alfred and place him on the floor before calibration (or use the bounded --undock probe)');
 await call(engine+'/v1/drive/wake',{});
 const initial=await call(engine+'/v1/mapping/native/frame');samples.push(initial);
 if(initial.native.reports?.['/task/WorkState']?.bytes?.[2]!==0)throw Error('Stop the firmware task first');
 await new Promise(resolve=>setTimeout(resolve,300));
 const stationary=await call(engine+'/v1/mapping/native/frame');samples.push(stationary);
 if(stationary.native.wheels.age_ms==null||stationary.native.wheels.age_ms>300)throw Error('Wheel odometry stale');
 if(stationary.native.wheels.values.some((v,i)=>Math.abs(v-initial.native.wheels.values[i])>2))throw Error('Wheels are already moving; calibration requires a stationary start');
 const started=Date.now();
 while(Date.now()-started<seconds*1000){
  const frame=await call(engine+'/v1/mapping/native/frame');samples.push(frame);
  if(frame.native.wheels.age_ms==null||frame.native.wheels.age_ms>300)throw Error('Wheel odometry stale');
  const body={linear_mm_s:mode==='forward'?speed:0,angular_rad_s:mode==='turn'?yaw:0,wheel_separation_mm:243};
  commands.push({at:Date.now(),command:body,result:await call(engine+'/v1/mapping/twist',body,'PUT')});
  await new Promise(resolve=>setTimeout(resolve,80));
 }
}catch(e){error=e.message;process.exitCode=1;}
finally{
 try{await call(engine+'/v1/drive/stop',{},'POST');}catch(e){error=error||e.message;process.exitCode=1;}
 try{
  // Include deceleration and reject movement from a competing publisher.
  for(let attempt=0;attempt<5;attempt++){
   await new Promise(resolve=>setTimeout(resolve,200));
   const frame=await call(engine+'/v1/mapping/native/frame');samples.push(frame);stopSamples.push(frame);
   if(stopSamples.some((_,i)=>stoppedWindow(stopSamples.slice(i)))){settled=true;break;}
  }
  if(!settled)throw Error('Wheels did not confirm a fresh stationary stop');
 }catch(e){error=error||e.message;process.exitCode=1;}
 const directory=new URL('../artifacts/hq/mapping-runs/',import.meta.url);await mkdir(directory,{recursive:true});
 const recording=new URL(`${Date.now()}-${mode}-${speed}mmps.json`,directory);
 await writeFile(recording,JSON.stringify({mode,speed,seconds,yaw,samples,commands,error,settled,stopSamples}));
 const first=samples[0]?.native.wheels,last=samples.at(-1)?.native.wheels;
 const delta=first&&last?last.values.map((value,i)=>value-first.values[i]):null;
 console.log(JSON.stringify({recording:recording.pathname,error,commands:commands.length,wheel_delta_mm:delta,mean_distance_mm:delta?(delta[0]+delta[1])/2:null}));
}
