import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {homedir} from 'node:os';
const cwd=fileURLToPath(new URL('../../botchat/',import.meta.url));
export function parseIntent(text) {
  const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'));
  if(!value || typeof value.say!=='string' || !value.say.trim() || value.say.length>500 ||
    !['none','stop','return','navigate','status'].includes(value.action) ||
    typeof value.section!=='string' || value.section.length>80 || typeof value.mapId!=='string' || value.mapId.length>80)
    throw Error('Alfred returned an invalid command; nothing was executed.');
  return value;
}
export function streamedSay(text) {
  text=text.replace(/^\s*```(?:json)?\s*/, '');
  const match=text.match(/^\s*\{\s*"say"\s*:\s*("(?:[^"\\]|\\.)*")/s);
  if(!match)return null;
  try {const say=JSON.parse(match[1]);return say.length<=500?say:null;} catch{return null;}
}
export class IntentModel {
  constructor({binary=process.env.ALFRED_AGY_BIN||path.join(homedir(),'.local/bin/agy'),timeout=45000}={}) {this.binary=binary;this.timeout=timeout;}
  start(model) {
    if(this.child && this.model===model && this.turns<24)return;
    this.close();this.model=model;this.turns=0;
    const child=spawn(this.binary,['--agent','alfred','--model',model,'--effort','low','--disable-slash-commands','--input-format','stream-json','--output-format','stream-json'],{cwd,stdio:['pipe','pipe','pipe']});
    this.child=child;
    const lines=createInterface({input:child.stdout});
    child.stderr.on('data',()=>{});
    child.stdin.on('error',e=>this.fail(e));
    child.on('error',e=>this.fail(e));
    child.on('close',()=>{if(this.child===child){this.child=null;this.fail(Error('Alfred model disconnected. Command was not resent.'));}});
    lines.on('line',line=>{
      if(this.child!==child)return;
      let event;try{event=JSON.parse(line);}catch{return;}
      if(event.event==='init' && event.init?.agent!=='alfred'){this.fail(Error('Alfred interpreter must have no tools. Install setup from docs/hq-chat.md.'));this.close();return;}
      const pending=this.pending;if(!pending)return;
      const step=event.step_update;
      if(step?.step_type==='tool'){this.fail(Error('Unexpected model tool request; command cancelled.'));this.close();return;}
      if(step?.step_type==='agent_response' && step.text_delta){
        pending.text+=step.text_delta;
        const say=streamedSay(pending.text);
        if(say&&!pending.spoken){pending.spoken=true;pending.onSay(say);}
      }
      if(event.event==='result'){
        this.turns++;
        clearTimeout(pending.timer);this.pending=null;
        try {
          if(event.result.status!=='SUCCESS')throw Error(event.result.error||'Alfred could not interpret the request.');
          const intent=parseIntent(event.result.response);
          pending.resolve({...intent,modelMs:Date.now()-pending.started});
        }catch(e){pending.reject(e);}
      }
    });
  }
  ask(input,{model='gemini-3.6-flash-low',onSay=()=>{}}={}) {
    if(this.pending)return Promise.reject(Error('Alfred is already interpreting a request.'));
    this.start(model);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fail(Error('Alfred timed out; nothing was resent.'));this.close();},this.timeout);
      this.pending={resolve,reject,timer,onSay,text:'',spoken:false,started:Date.now()};
      this.child.stdin.write(JSON.stringify({event:'user',message:{content:'Return JSON only with keys in this order: say (string), action (none|stop|return|navigate|status), section (string), mapId (string). Interpret only currentUser. Fresh context:\n'+JSON.stringify(input)}})+'\n');
    });
  }
  fail(error){if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}}
  close(){const child=this.child;this.child=null;if(child){child.stdin.end();child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),1000);timer.unref();}this.fail(Error('Alfred model session closed.'));}
}
