import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {directCommand} from '../src/bot/direct-command.mjs';
import {ChatService} from '../src/bot/chat-service.mjs';
import {RobotIntents} from '../src/bot/robot-intents.mjs';
test('whole command grammar accepts wake/politeness and rejects conversational mentions',()=>{
 for(const text of ['Stop! Stop!','Alfred, stop.','Please stop now'])assert.equal(directCommand(text).action,'stop');
 assert.equal(directCommand('Return to station').action,'return');
 assert.equal(directCommand('Alfred go to the bedroom please').section,'bedroom');
 for(const text of ["Don't stop",'Should I stop?','Say stop','Go to bedroom then return','If I say return to station'])assert.equal(directCommand(text),null,text);
});
test('commands bypass context/model; stop invalidates a late model movement response',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'alfred-fast-'));
 try{
 let resolve,asked=0,contexts=0;const actions=[];
 const service=new ChatService({}, {file:path.join(dir,'chat.json'),poll:false,direct:{
  model:{ask:async()=>{asked++;return new Promise(r=>{resolve=r;});}},
  commands:{context:async()=>{contexts++;return {};},execute:async intent=>{actions.push(intent.action);return {state:'ok'};}}
 }});
 await service.ready;Object.assign(service.state,{enabled:true,agent:'antigravity'});
 const finish=async()=>{while(service.state.pending)await new Promise(r=>setImmediate(r));await service.queue;};
 for(const text of ['return to station','go to bedroom','stop']){await service.send(text);await finish();}
 assert.equal(asked,0);assert.equal(contexts,0);
 await service.send('Please find somewhere quiet');
 while(!resolve)await new Promise(r=>setImmediate(r));
 await service.send('stop');await finish();
 resolve({action:'navigate',section:'bedroom',say:'Heading to bedroom.'});
 await new Promise(r=>setImmediate(r));await service.queue;
 assert.deepEqual(actions,['return','navigate','stop','stop']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cancellation during section resolution prevents movement',async()=>{
 let active=true;
 const robot=new RobotIntents({resolveSection:async()=>{active=false;return {status:'resolved',section:{target:{x:1,y:2},mapId:'map'}};},navigateTo:()=>assert.fail('cancelled movement')},{},{},async()=>{});
 await assert.rejects(robot.execute({action:'navigate',section:'bedroom'},()=>active),/cancelled/);
});
