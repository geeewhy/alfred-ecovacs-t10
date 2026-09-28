// Exercise manual mapping without pausing its capture; bounded drive + stop.
import {mkdir,writeFile} from 'node:fs/promises';
const hq='http://127.0.0.1:4173',engine='http://127.0.0.1:48765';
async function api(base,path,body,method){
 const r=await fetch(base+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(1500)});
 const v=await r.json();if(!r.ok||!v.ok)throw Error(v.error||v.result||'Request failed');return v.result;
}
const evidence={at:Date.now(),samples:[],commands:[]};
try{
 const active=await api(hq,'/api/maps/active');
 if(active?.mode!=='manual'||active.state!=='scanning')throw Error('Manual capture must already be active');
 evidence.map=active.id;evidence.before=active;
 const initial=await api(engine,'/v1/mapping/native/frame');
 evidence.initial=initial;
 if(initial.native.reports?.['/task/WorkState']?.bytes?.[2]!==0)throw Error('Native controller is active');
 const began=Date.now();
 while(Date.now()-began<1000){
  evidence.commands.push(await api(engine,'/v1/mapping/twist',{linear_mm_s:120,angular_rad_s:0,wheel_separation_mm:243},'PUT'));
  evidence.samples.push(await api(hq,'/api/maps/active'));
  await new Promise(r=>setTimeout(r,100));
 }
}catch(e){evidence.error=e.message;process.exitCode=1;}
finally{
 try{await api(engine,'/v1/drive/stop',{});}catch(e){evidence.stopError=e.message;process.exitCode=1;}
 for(let i=0;i<5;i++){
  try{evidence.samples.push(await api(hq,'/api/maps/active'));}catch(e){evidence.readError=e.message;break;}
  await new Promise(r=>setTimeout(r,200));
 }
 try{evidence.final=await api(engine,'/v1/mapping/native/frame');}catch(e){evidence.readError=e.message;}
 const dir=new URL('../artifacts/hq/mapping-runs/',import.meta.url);await mkdir(dir,{recursive:true});
 const path=new URL(`${evidence.at}-manual-capture.json`,dir);await writeFile(path,JSON.stringify(evidence));
 const last=evidence.samples.at(-1);
 console.log(JSON.stringify({recording:path.pathname,error:evidence.error,stopError:evidence.stopError,commands:evidence.commands.length,before:evidence.before,after:last}));
}
