import {writeFile} from 'node:fs/promises';
async function api(action){const r=await fetch(`http://127.0.0.1:48765/v1/mapping/native/${action}`,{method:['status','snapshot'].includes(action)?'GET':'POST',signal:AbortSignal.timeout(3000)});const v=await r.json();if(!v.ok)throw Error(v.result);return v.result;}
const out={before:await api('status'),samples:[]};
try{
 out.snapshot=await api('snapshot');
 await api('backend-start');await api('resume');
 for(let i=0;i<10;i++){out.samples.push(await api('status'));await new Promise(r=>setTimeout(r,500));}
 console.log(JSON.stringify(out.samples.at(-1)));
}finally{
 await api('backend-off').catch(()=>{});await api('pause').catch(()=>{});
 const path=new URL(`../artifacts/hq/mapping-runs/${Date.now()}-backend-gate.json`,import.meta.url);await writeFile(path,JSON.stringify(out));console.log(path.pathname);
}
