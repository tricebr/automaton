import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createFounderResearch} from './founder-research.mjs';
test('research adapter can continue after an interrupted source request',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'research-stop-'));let entered;const started=new Promise(r=>entered=r);let interrupt=true;
 const request=async(input,options)=>{if(interrupt){interrupt=false;entered();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}const url=String(input);return Response.json(url.includes('api.github.com')?{incomplete_results:false,items:[{html_url:'https://github.com/example/repo/issues/2',title:'Automation needed',body:'Manual invoice work',created_at:new Date().toISOString()}]}:url.includes('askstories')?[12]:{type:'story',time:Math.floor(Date.now()/1000),title:'Ask HN: invoice',text:'Needs automation'});};
 const a=createFounderResearch({directory:path.join(dir,'research'),request}),abort=new AbortController();
 try{const run=a.execute({signal:abort.signal,assertActive(){if(abort.signal.aborted)throw Error('stopped');}});await started;abort.abort();await assert.rejects(run);const r=await a.execute({signal:new AbortController().signal,assertActive(){}});assert.ok(a.verify(r));}finally{a.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('research runs autonomous public source discovery and records reported evidence',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'founder-research-'));const request=async(input,options)=>{assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');const url=String(input);return new Response(JSON.stringify(url.includes('api.github.com')?{incomplete_results:false,items:[{html_url:'https://github.com/example/repo/issues/1',title:'Invoice automation needed',body:'Manual workflow takes time',created_at:new Date().toISOString()}]}:url.includes('askstories')?[12]:{type:'story',time:Math.floor(Date.now()/1000)-60,title:'Ask HN: invoice workflow',text:'Need simpler invoice tools'}),{headers:{'Content-Type':'application/json'}});};
 const a=createFounderResearch({directory:path.join(dir,'research'),request});try{const result=await a.execute({signal:new AbortController().signal,assertActive(){}});assert.ok(await a.verify(result));assert.ok(result.sources.length>0);assert.ok(result.sources.every(s=>s.verification==='reported'));}finally{a.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('autonomous review pauses defer future research without provider calls or quota resets',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'research-wait-'));let calls=0;
 const request=async(input)=>{calls++;const url=String(input);return Response.json(url.includes('api.github.com')?{incomplete_results:false,items:[{html_url:'https://github.com/example/repo/issues/1',title:'Invoice workflow',body:'Manual work',created_at:new Date().toISOString()}]}:url.includes('askstories')?[12]:{type:'story',time:Math.floor(Date.now()/1000),title:'Ask HN: invoices',text:'Need simpler invoice tools'});};
 const a=createFounderResearch({directory:path.join(dir,'research'),request});try{assert.equal(a.nextReadyAt,0);let r;for(let i=0;i<30;i++){r=await a.execute({signal:new AbortController().signal,assertActive(){}});if(!r.processed)break;}assert.equal(r.processed,0);const before=calls;assert.ok(a.nextReadyAt>Date.now());assert.equal(calls,before);}finally{a.close();fs.rmSync(dir,{recursive:true,force:true});}
});
