import test from 'node:test';
import assert from 'node:assert/strict';
import {AdbClient} from '../src/bot/adb-client.mjs';
const ok={code:0,stdout:'',stderr:''};
test('healthy transport is reused across shell requests without reconnecting',async()=>{
 const calls=[];const client=new AdbClient({run:async(_,args)=>{calls.push(args);return {...ok,stdout:args.at(-1)==='get-state'?'device\n':'done'};}},'robot:5555');
 for(let i=0;i<50;i++)await client.shell('true');
 assert.equal(calls.filter(a=>a[0]==='connect').length,0);
 assert.equal(calls.filter(a=>a[2]==='shell').length,50);
});
test('offline transport is removed before a single reconnect',async()=>{
 const calls=[];const client=new AdbClient({run:async(_,args)=>{calls.push(args);return args.at(-1)==='get-state'?{code:1,stdout:'',stderr:'device offline'}:{...ok,stdout:'connected to robot:5555'};}},'robot:5555');
 await client.connect();assert.deepEqual(calls,[['-s','robot:5555','get-state'],['disconnect','robot:5555'],['connect','robot:5555']]);
});
test('failed shell mutation is never replayed',async()=>{
 let shells=0;const client=new AdbClient({run:async(_,args)=>args.at(-1)==='get-state'?{...ok,stdout:'device'}:(shells++,{code:1,stdout:'',stderr:'closed'})},'robot:5555');
 await assert.rejects(client.shell('motion-command'),/closed/);assert.equal(shells,1);
});
