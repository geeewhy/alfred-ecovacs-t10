import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatService } from '../src/bot/chat-service.mjs';

test('closed session recovers once, retains history and model, and waits for launch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alfred-chat-'));
  try {
    const file = path.join(dir, 'chat.json');
    const messages = [{ role: 'you', text: 'hello' }];
    await writeFile(file, JSON.stringify({ enabled: true, sessionId: 'closed', model: 'chosen-model', messages }));
    const calls = []; let listed = false;
    const service = new ChatService({}, { file, poll: false, command: async args => {
      calls.push(args);
      if (args[0] === 'list') return { sessions: listed ? [{ id: 'live', label: service.state.sessionLabel, thread: 'one-offs/diy-ecovacs-t10-salvage/botchat', agent: 'codex' }] : [] };
      if (args[1] === 'open') return {};
      if (args[2] === 'closed') return { closed: true };
      return { id: 'live', agent: 'codex', thread: 'one-offs/diy-ecovacs-t10-salvage/botchat', pane_live: true, transcript_path: '/tmp/transcript' };
    }});
    await service.ready;
    await service.exclusive(() => service.ensureSession());
    await service.exclusive(() => service.ensureSession());
    assert.equal(calls.filter(args => args[1] === 'open').length, 1);
    listed = true;
    await service.exclusive(() => service.ensureSession());
    assert.equal(service.snapshot().sessionStatus, 'ready');
    assert.equal(service.state.sessionId, 'live');
    assert.deepEqual(service.state.messages, messages);
    assert.equal(service.state.model, 'chosen-model');
    assert.equal(calls.filter(args => args[1] === 'send').length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('disabled chat does not create a session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alfred-chat-'));
  try {
    const service = new ChatService({}, { file: path.join(dir, 'chat.json'), poll: false, command: async () => { throw Error('unexpected CLI call'); } });
    await service.exclusive(() => service.poll());
    assert.equal(service.snapshot().sessionStatus, 'off');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('large tool output cannot strand a completed reply or replay it after restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alfred-chat-'));
  try {
    const file = path.join(dir, 'chat.json'), transcript = path.join(dir, 'transcript.jsonl');
    const final = JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Ready.'}],internal_chat_message_metadata_passthrough:{turn_id:'turn'}}});
    await writeFile(transcript, JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',output:'x'.repeat(1207630)}})+'\n'+final+'\n');
    await writeFile(file, JSON.stringify({enabled:true,pending:{id:'request',path:transcript,offset:0,agent:'codex',turnId:'turn',started:Date.now()-30000},messages:[]}));
    const service = new ChatService({}, {file,poll:false});
    await service.exclusive(()=>service.poll());
    assert.equal(service.state.pending,null);
    assert.equal(service.state.error,null);
    assert.equal(service.state.messages[0].text,'Ready.');
    const restored = new ChatService({}, {file,poll:false});
    await restored.ready;
    assert.equal(restored.state.pending,null);
    assert.equal(restored.state.messages.length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('partial transcript records are retried intact, including Unicode', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alfred-chat-'));
  try {
    const file=path.join(dir,'chat.json'), transcript=path.join(dir,'transcript.jsonl');
    const line=JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Prêt.'}],internal_chat_message_metadata_passthrough:{turn_id:'turn'}}});
    await writeFile(transcript,line);
    await writeFile(file,JSON.stringify({pending:{id:'r',path:transcript,offset:0,agent:'codex',turnId:'turn',started:Date.now()},messages:[]}));
    const service=new ChatService({}, {file,poll:false});
    await service.exclusive(()=>service.poll());
    assert.equal(service.state.pending.offset,0);
    await writeFile(transcript,line+'\n');
    await service.exclusive(()=>service.poll());
    assert.equal(service.state.pending,null);
    assert.equal(service.state.messages[0].text,'Prêt.');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('LLM progress precedes result playback without automatic receipt', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'alfred-chat-'));
  try {
    const file=path.join(dir,'chat.json'), transcript=path.join(dir,'transcript.jsonl');
    await writeFile(transcript,'');
    const spoken=[];
    let release;
    const speech={say:async text=>{spoken.push(text);if(text==='Returning.')await new Promise(resolve=>{release=resolve;});}};
    const service=new ChatService(speech,{file,poll:false,command:async args=>{
      if(args[1]==='send'){assert.equal(service.state.messages.at(-1).role,'you');assert.ok(args[3].length<500);assert.match(args[3],/^\[HQ_ALFRED_REQUEST:/);assert.match(args[3],/chat-requests/);}
      return {};
    }});
    await service.ready;
    service.state.enabled=true;service.state.speaker=true;
    service.session=async()=>({id:'session',transcript_path:transcript});
    await service.send('Hello');
    assert.equal(service.state.messages.length,1);
    await service.exclusive(()=>service.progressReply(service.state.pending,'Returning.'));
    await service.exclusive(()=>service.finishReply(service.state.pending,'Ready.'));
    assert.deepEqual(spoken,['Returning.']);
    release();await service.playback;
    assert.deepEqual(spoken,['Returning.','Ready.']);
    assert.equal(service.state.messages[1].audio,'sent');
    assert.equal(service.state.messages[2].audio,'sent');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Claude truncated legacy request recovers its existing final without resending', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'alfred-chat-'));
  try {
    const file=path.join(dir,'chat.json'), transcript=path.join(dir,'transcript.jsonl');
    const started=Date.now()-10000;
    await writeFile(transcript,[
      {type:'user',uuid:'user',timestamp:new Date(started+1).toISOString(),message:{content:'truncated instructions\n\nUser: which model?'}},
      {type:'assistant',message:{content:[{type:'text',text:'Haiku.'}],stop_reason:'end_turn'}}
    ].map(JSON.stringify).join('\n')+'\n');
    await writeFile(file,JSON.stringify({messages:[{id:'r',text:'which model?'}],pending:{id:'r',agent:'claude',path:transcript,offset:999,started,turnId:null}}));
    const service=new ChatService({}, {file,poll:false,command:async()=>{throw Error('Must not resend');}});
    await service.exclusive(()=>service.poll());
    assert.equal(service.state.pending,null);
    assert.equal(service.state.messages.at(-1).text,'Haiku.');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Antigravity recovers wrapped request and final, ignoring tools and unrelated replies', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'alfred-chat-'));
  try {
    const file=path.join(dir,'chat.json'), transcript=path.join(dir,'transcript.jsonl');
    const records=[
      {step_index:0,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'Unrelated'},
      {step_index:1,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',content:'<USER_REQUEST>\n[HQ_ALFRED_REQUEST:r] Read request file\n</USER_REQUEST>'},
      {step_index:2,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'Checking',tool_calls:[{name:'view_file'}]},
      {step_index:3,source:'MODEL',type:'GENERIC',status:'DONE',content:'tool output'},
      {step_index:4,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'Hello.'}
    ];
    const data=records.map(JSON.stringify).join('\n')+'\n';
    await writeFile(transcript,data);
    await writeFile(file,JSON.stringify({messages:[],pending:{id:'r',agent:'antigravity',path:transcript,offset:Buffer.byteLength(data),started:Date.now(),turnId:null}}));
    const service=new ChatService({}, {file,poll:false});
    await service.exclusive(()=>service.poll());
    assert.equal(service.state.pending,null);
    assert.equal(service.state.messages.at(-1).text,'Hello.');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('idle development session migrates to botchat without changing model or history', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'alfred-chat-'));
  try {
    const file=path.join(dir,'chat.json');
    await writeFile(file,JSON.stringify({enabled:true,sessionId:'old',agent:'antigravity',model:'gemini-3.6-flash-low',messages:[{role:'you',text:'hello'}]}));
    const calls=[];
    const service=new ChatService({}, {file,poll:false,command:async args=>{
      calls.push(args);
      if(args[1]==='inspect')return {id:'old',thread:'one-offs/diy-ecovacs-t10-salvage',agent:'antigravity',pane_live:true};
      if(args[0]==='list')return {sessions:[]};
      return {};
    }});
    await service.exclusive(()=>service.ensureSession());
    const launch=calls.find(args=>args[1]==='open');
    assert.equal(launch[2],'one-offs/diy-ecovacs-t10-salvage/botchat');
    assert.ok(launch.includes('gemini-3.6-flash-low'));
    assert.equal(service.state.messages.length,1);
    assert.equal(calls.filter(args=>args[1]==='send').length,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
