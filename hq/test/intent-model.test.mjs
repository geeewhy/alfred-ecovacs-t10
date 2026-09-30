import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIntent,streamedSay} from '../src/bot/intent-model.mjs';
import {RobotIntents} from '../src/bot/robot-intents.mjs';
test('streamed acknowledgment requires a complete JSON string, never an action',()=>{
 assert.equal(streamedSay('{"say":"Heading to'),null);
 assert.equal(streamedSay('{"say":"Heading to bedroom.","action":'),'Heading to bedroom.');
 assert.throws(()=>parseIntent('{"say":"Heading to bedroom.","action":'));
 assert.throws(()=>parseIntent('{"say":"Done","action":"shell","section":"","mapId":""}'));
});
test('navigation resolves fresh section and never uses LLM coordinates',async()=>{
 const calls=[];
 const maps={resolveSection:async(name,id)=>{calls.push([name,id]);return {status:'resolved',section:{mapId:'real-map',target:{x:1,y:2,theta:0}}};},navigateTo:async(id,pose)=>{calls.push([id,pose]);return {active:true,state:'navigating'};}};
 const commands=new RobotIntents(maps,{},{});
 await commands.execute(parseIntent('{"say":"Heading there.","action":"navigate","section":"Bedroom","mapId":"real-map","x":999}'));
 assert.deepEqual(calls,[['Bedroom','real-map'],['real-map',{x:1,y:2,theta:0}]]);
});
test('ambiguous section never starts movement',async()=>{
 let moved=false;
 const commands=new RobotIntents({resolveSection:async()=>({status:'ambiguous'}),navigateTo:async()=>{moved=true;}},{},{});
 await assert.rejects(commands.execute({action:'navigate',section:'Bedroom'}),/Which map/);
 assert.equal(moved,false);
});
test('conversation and status do not execute movement',async()=>{
 const commands=new RobotIntents({}, {}, {});
 assert.deepEqual(await commands.execute({action:'none'}),{state:'answered'});
 assert.deepEqual(await commands.execute({action:'status'}),{state:'answered'});
});
