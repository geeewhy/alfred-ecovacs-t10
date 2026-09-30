import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechService } from '../src/bot/speech-service.mjs';
import { VoiceService } from '../src/bot/voice-service.mjs';

test('wake blip leaves capture open; ordinary playback immediately pauses it',async()=>{
  const speech=new SpeechService({request:async()=>({ok:true})});
  const voice=new VoiceService({},speech);clearInterval(voice.tick);
  const controls=[];
  voice.child={stdin:{writable:true,write:line=>controls.push(JSON.parse(line))}};
  await speech.click({wake:true});
  assert.equal(controls.length,0);
  assert.ok(!speech.speakingUntil);
  await speech.click();
  assert.deepEqual(controls,[{paused:true}]);
  assert.ok(speech.speakingUntil>Date.now());
});

test('voice request pauses before dispatch and does not produce a second click',async()=>{
  const calls=[];
  const chat={current:async()=>({enabled:true,sessionStatus:'ready'}),send:async(text,options)=>calls.push({text,options})};
  const voice=new VoiceService(chat,{});clearInterval(voice.tick);
  voice.child={stdin:{writable:true,write:()=>calls.push('pause')}};
  await voice.submit('Battery?');
  assert.deepEqual(calls,['pause',{text:'Battery?',options:{receipt:false}}]);
});

test('transcription arriving during playback cannot reach chat',async()=>{
  let sent=false;
  const voice=new VoiceService({current:async()=>({enabled:true,sessionStatus:'ready'}),send:async()=>sent=true},{speakingUntil:Date.now()+10000});
  clearInterval(voice.tick);
  await voice.submit('Alfred at your service');
  assert.equal(sent,false);
});
