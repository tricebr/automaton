import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createServiceReaders} from './founder-service-readers.mjs';
const ctx={assertActive(){},signal:new AbortController().signal};
test('Gmail metadata stays private, ambiguous threads remain unassigned and successful timestamp survives failure',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gmail-metadata-'));let clock=Date.now(),fail=false;
 const r=createServiceReaders({directory:dir,now:()=>clock,access:()=>({available:true,credential:'t',scope:{account:'numaronia@gmail.com',labelId:'Label_1'}}),request:async u=>{if(fail)return new Response(null,{status:401});return Response.json(u.includes('format=metadata')?{id:'abc',threadId:'def',labelIds:['Label_1'],payload:{headers:[{name:'Subject',value:'Review by 2026-10-20'}]}}:{messages:[{id:'abc',threadId:'def'}]});}});
 try{const first=await r.adapters['gmail-orders'].execute(ctx);assert.equal(first.privacy,'private');assert.equal(first.data.messages[0].ownOrderId,null);assert.equal(first.data.deadlineProposals[0].confirmed,false);assert.equal(r.status()[1].lastSuccessfulAt,clock);clock+=3600001;fail=true;await assert.rejects(r.adapters['gmail-orders'].execute(ctx));assert.equal(r.status()[1].lastSuccessfulAt,clock-3600001);}finally{r.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing access never calls service and scope selects only dedicated Gmail label',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'readers-'));let calls=[];
 const r=createServiceReaders({directory:dir,access:()=>({available:false}),request:async u=>{calls.push(u);return Response.json({});},registry:[]});
 try{assert.equal(r.adapters['gmail-orders'].available,false);await assert.rejects(r.adapters['gmail-orders'].execute(ctx));assert.equal(calls.length,0);}finally{r.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Gmail uses approved account and label; repeated and unauthorized attempts are bounded across restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'readers-'));let calls=[],clock=Date.now();const access=()=>({available:true,credential:'token',scope:{account:'numaronia@gmail.com',labelId:'Label_1'}});
 const request=async (u,o)=>{calls.push(u);assert.equal(o.method,'GET');assert.equal(o.redirect,'error');return new Response('',{status:401});};let r=createServiceReaders({directory:dir,access,request,now:()=>clock});
 try{await assert.rejects(r.adapters['gmail-orders'].execute(ctx));assert.ok(calls[0].includes('labelIds=Label_1'));assert.ok(calls[0].includes('numaronia%40gmail.com'));r.close();r=createServiceReaders({directory:dir,access,request,now:()=>clock});await assert.rejects(r.adapters['gmail-orders'].execute(ctx));assert.equal(calls.length,1);assert.equal(r.status().find(x=>x.kind==='gmail-orders').last.status,'unauthorized');}finally{r.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('public GitHub reads only registered URLs and marks malformed auxiliary responses partial',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'readers-'));let urls=[];
 const r=createServiceReaders({directory:dir,registry:[{id:'own-12',provider:'github',externalId:'owner/project/pull/12'}],request:async u=>{urls.push(u);return Response.json({number:12,state:'closed',merged:true,user:{login:'someone-else'}});}});
 try{const result=await r.adapters['github-orders'].execute(ctx);assert.equal(urls.length,3);assert.equal(result.evidence[0].kind,'observation');assert.equal(result.evidence[0].payload.author,'someone-else');assert.equal(result.evidence[0].payload.acceptanceConfirmed,false);assert.equal(result.data.partial,true);assert.equal(result.sources[0].url,'https://github.com/owner/project/pull/12');assert.equal(r.adapters['github-orders'].verify(result),true);}finally{r.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('oversized and redirect responses are rejected without disclosing response content',async()=>{
 for(const response of [()=>new Response('x'.repeat(200001)),()=>new Response(null,{status:302,headers:{Location:'https://example.com'}})]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'readers-boundary-'));
  const r=createServiceReaders({directory:dir,registry:[{id:'own',provider:'github',externalId:'owner/project/pull/12'}],request:async()=>response()});
  try{await assert.rejects(r.adapters['github-orders'].execute(ctx),/Service read failed/);assert.equal(r.status()[0].last.status,'failed');}finally{r.close();fs.rmSync(dir,{recursive:true,force:true});}
 }
});

test('Gmail advances bounded metadata batches across restart and records only exact own links',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gmail-cursor-'));let clock=Date.now(),seen=[];
 const registry=[{id:'own',provider:'github',externalId:'owner/project/pull/12'}];const options={directory:dir,registry,now:()=>clock,access:()=>({available:true,credential:'t',scope:{account:'numaronia@gmail.com',labelId:'Label_1'}}),request:async u=>{if(!u.includes('format=metadata'))return Response.json({messages:Array.from({length:8},(_,i)=>({id:(i+10).toString(16)}))});const id=u.split('/messages/')[1].split('?')[0];seen.push(id);return Response.json({id,threadId:id,labelIds:['Label_1'],payload:{headers:[{name:'Subject',value:'Review 2026-10-20'},{name:'Archived-At',value:id==='a'?'<https://github.com/owner/project/pull/12#issuecomment-1>':'https://github.com/foreign/project/pull/12'}]}});}};let r=createServiceReaders(options);
 try{const first=await r.adapters['gmail-orders'].execute(ctx);assert.equal(first.data.messages[0].ownOrderId,'own');assert.equal(first.evidence.length,1);assert.equal(first.evidence[0].payload.assignmentConfirmed,false);r.close();clock+=3600001;r=createServiceReaders(options);await r.adapters['gmail-orders'].execute(ctx);assert.equal(new Set(seen).size,8);assert.equal(seen.length,8);}finally{r.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('calendar detects overlaps but labels linked dates as unconfirmed order deadlines',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-link-'));const r=createServiceReaders({directory:dir,registry:[{id:'own',provider:'github',externalId:'owner/project/pull/12'}],access:()=>({available:true,credential:'t',scope:{account:'numaronia@gmail.com',calendarId:'own-calendar'}}),request:async()=>Response.json({items:[{id:'one',description:'https://github.com/owner/project/pull/12',start:{dateTime:'2026-10-20T10:00:00Z'},end:{dateTime:'2026-10-20T12:00:00Z'},status:'confirmed'},{id:'two',start:{dateTime:'2026-10-20T11:00:00Z'},end:{dateTime:'2026-10-20T13:00:00Z'},status:'confirmed'}]})});try{const result=await r.adapters['calendar-deadlines'].execute(ctx);assert.equal(result.data.events[0].ownOrderId,'own');assert.equal(result.data.events[0].deadlineConfirmed,false);assert.equal(result.data.conflicts.length,1);assert.equal(result.evidence.length,1);}finally{r.close();fs.rmSync(dir,{recursive:true,force:true});}
});
