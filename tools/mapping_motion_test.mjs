// Bounded physical calibration. Records sensors; does not infer ground truth
// from a custom mapper. Compare wheel distance against an actual floor mark.
import {mkdir,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2),mode=args.find(a=>!a.startsWith('--'))||'forward';
const number=(key,fallback)=>Number(args.find(a=>a.startsWith(`--${key}=`))?.split('=')[1]??fallback);
const speed=number('speed',120),seconds=number('seconds',2),yaw=number('yaw',.35);
if(!['forward','turn'].includes(mode)||![speed,seconds,yaw].every(Number.isFinite)||speed<=0||seconds<=0||seconds>15||yaw===0)throw Error('Use forward/turn, --speed=mm/s, --yaw=rad/s, --seconds=1–15');
if(args.includes('--help')){console.log('node tools/mapping_motion_test.mjs forward --speed=120 --seconds=2\nnode tools/mapping_motion_test.mjs turn --yaw=0.35 --seconds=2');process.exit(0);}
const engine='http://127.0.0.1:48765';
async function call(url,body,method){
 const response=await fetch(url,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(1500)});
 const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||value.result||'Robot request failed');return value.result;
}
const samples=[],commands=[];let error;
try{
 await call('http://127.0.0.1:4173/api/maps/active/pause',{});
 const battery=await call(engine+'/v1/telemetry/battery');
 if(battery.percent==null||battery.percent<=10||battery.low_voltage||battery.on_charger)throw Error('Charge Alfred and place him on the floor before calibration');
 await call(engine+'/v1/drive/wake',{});
 const initial=await call(engine+'/v1/mapping/native/frame');samples.push(initial);
 if(initial.native.reports?.['/task/WorkState']?.bytes?.[2]!==0)throw Error('Stop the firmware task first');
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
 try{samples.push(await call(engine+'/v1/mapping/native/frame'));}catch{}
 const directory=new URL('../artifacts/hq/mapping-runs/',import.meta.url);await mkdir(directory,{recursive:true});
 const recording=new URL(`${Date.now()}-${mode}-${speed}mmps.json`,directory);
 await writeFile(recording,JSON.stringify({mode,speed,seconds,yaw,samples,commands,error}));
 const first=samples[0]?.native.wheels,last=samples.at(-1)?.native.wheels;
 const delta=first&&last?last.values.map((value,i)=>value-first.values[i]):null;
 console.log(JSON.stringify({recording:recording.pathname,error,commands:commands.length,wheel_delta_mm:delta,mean_distance_mm:delta?(delta[0]+delta[1])/2:null}));
}
