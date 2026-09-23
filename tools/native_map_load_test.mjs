// Restore a freshly captured native map while stationary; no wheel commands.
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:48765';
async function call(path,body,method){const response=await fetch(base+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});const v=await response.json();if(!v.ok)throw Error(v.result);return v.result;}
const out={samples:[]};
try{
 await fetch('http://127.0.0.1:48766/pause',{method:'POST',signal:AbortSignal.timeout(1500)});
 await call('/v1/drive/stop',null,'POST');
 out.before=await call('/v1/mapping/native/status');out.snapshot=await call('/v1/mapping/native/snapshot');
 if(!out.snapshot.map.cells.length||!out.snapshot.close_map.cells.length)throw Error('Both native maps must be populated');
 const dir=new URL('../artifacts/hq/mapping-runs/',import.meta.url);await mkdir(dir,{recursive:true});
 out.file=new URL(`${Date.now()}-native-load.json`,dir).pathname;
 await writeFile(out.file,JSON.stringify(out)); // Preserve maps before requesting load.
 out.load=await call('/v1/mapping/native/load',out.snapshot);
 await call('/v1/mapping/native/resume',null,'POST');
 for(let i=0;i<10;i++){out.samples.push(await call('/v1/mapping/native/status'));await new Promise(r=>setTimeout(r,500));}
 console.log(JSON.stringify({before:out.before,after:out.samples.at(-1),file:out.file}));
}finally{
 await call('/v1/drive/stop',null,'POST').catch(()=>{});
 await call('/v1/mapping/native/pause',null,'POST').catch(()=>{});
 if(out.file)await writeFile(out.file,JSON.stringify(out));
}
