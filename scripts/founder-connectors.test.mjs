import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createFounderConnectors} from './founder-connectors.mjs';
const context=()=>({signal:new AbortController().signal,assertActive(){},grant:{reservationId:'test',maxCostRappen:0},dependencies:[],task:{input:{}}});
test('keyless Exa has bounded calls, no authorization and persistent quota',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connectors-'));let calls=0;
 const request=async(url,opts)=>{calls++;assert.equal(new Headers(opts.headers).has('authorization'),false);assert.equal(opts.redirect,'error');return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'Title: public demand\nURL: https://github.com/example/project/issues/1\nText: documentation requested'}]}});};
 let c=createFounderConnectors({directory:dir,request});try{
 const a=c.adapters['exa-research'];await assert.rejects(()=>a.execute({...context(),grant:null}));assert.equal(calls,0);
 const r=await a.execute(context());assert.equal(a.verify(r),true);assert.equal(r.sources.length,1);assert.equal(r.costReceipt.actualCostRappen,0);
 c.close();c=createFounderConnectors({directory:dir,request});await assert.rejects(()=>c.adapters['exa-research'].execute(context()));assert.equal(calls,1);
 }finally{c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Firecrawl rejects unknown targets and SOFA stays unavailable without credentials',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connectors-'));let calls=0;const c=createFounderConnectors({directory:dir,request:async()=>{calls++;return Response.json({});}});
 try{assert.equal(c.adapters['sofa-research'].available,false);for(const url of ['http://localhost/x','https://127.0.0.1/x','https://evil.test/x'])await assert.rejects(()=>c.adapters['firecrawl-research'].execute({...context(),dependencies:[{sources:[{url}]}]}));assert.equal(calls,0);}finally{c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('upstream errors are bounded and never retried or exposed',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connectors-'));let calls=0;const c=createFounderConnectors({directory:dir,request:async()=>{calls++;return new Response('secret upstream detail',{status:429});}});
 try{await assert.rejects(()=>c.adapters['exa-research'].execute(context()),/Provider HTTP 429/);await assert.rejects(()=>c.adapters['exa-research'].execute(context()),/quota/);assert.equal(calls,1);}finally{c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Firecrawl only scrapes one admitted source, never sends billing credentials',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connectors-'));let calls=0;const c=createFounderConnectors({directory:dir,request:async(url,opts)=>{calls++;assert.equal(url,'https://api.firecrawl.dev/v2/scrape');assert.equal(new Headers(opts.headers).has('authorization'),false);assert.deepEqual(JSON.parse(opts.body),{url:'https://github.com/example/project/issues/1',formats:['markdown'],onlyMainContent:true,timeout:20000});return Response.json({success:true,data:{markdown:'A public reported request, not a paid assignment.'}});}});
 try{const r=await c.adapters['firecrawl-research'].execute({...context(),dependencies:[{sources:[{url:'https://github.com/example/project/issues/1'}]}]});assert.equal(c.adapters['firecrawl-research'].verify(r),true);assert.equal(calls,1);}finally{c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('SOFA authenticates sessions then searches and inspects, without publishing',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connectors-'));let calls=0;const id='12345678-1234-1234-1234-123456789abc';const c=createFounderConnectors({directory:dir,sofaKey:'test-key-not-a-secret-123456',request:async(url,opts)=>{calls++;if(url.endsWith('/skill.md'))return new Response('guide',{headers:{'x-sofa-skill-digest':'a'.repeat(64)}});assert.equal(opts.headers.Authorization,'Bearer test-key-not-a-secret-123456');if(url.endsWith('/api/sessions'))return Response.json({session_id:id});assert.equal(opts.headers['X-Sofa-Session'],id);if(url.includes('?search='))return Response.json({posts:[{id,content_type:'til'}]});assert.equal(url,`https://agents.stackoverflow.com/api/posts/${id}`);return Response.json({id,content_type:'til',title:'Budget retries',body:'Test local mocks before paid probes.'});}});
 try{const r=await c.adapters['sofa-research'].execute(context());assert.equal(c.adapters['sofa-research'].verify(r),true);assert.equal(calls,4);assert.equal(r.sources[0].verification,'reported');assert.ok(!JSON.stringify(r).includes('test-key'));}finally{c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('empty evidence and expired policies cannot report connected or invoke provider',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connectors-'));let at=Date.parse('2026-10-13T12:00:00Z'),calls=0;const c=createFounderConnectors({directory:dir,now:()=>at,request:async()=>{calls++;return Response.json({id:1,result:{content:[]}});}});
 try{await assert.rejects(()=>c.adapters['exa-research'].execute(context()),/No admissible/);assert.equal(c.status()[0].last.status,'attempted');at=Date.parse('2026-10-21T12:00:00Z');await assert.rejects(()=>c.adapters['exa-research'].execute(context()),/Access/);assert.equal(calls,1);}finally{c.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('spent connector windows defer future jobs and HTTP errors retain only safe status diagnostics',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connector-wait-'));let at=Date.parse('2026-10-15T18:01:00Z'),calls=0;
 const c=createFounderConnectors({directory:dir,now:()=>at,request:async()=>{calls++;return new Response('private upstream body',{status:401});}});
 try{const a=c.adapters['firecrawl-research'];assert.equal(a.nextReadyAt,0);await assert.rejects(()=>a.execute({...context(),dependencies:[{sources:[{url:'https://github.com/example/repo'}]}]}),e=>e.diagnostic?.code==='service_unauthorized'&&e.diagnostic.httpStatus===401&&!JSON.stringify(e).includes('private upstream'));
 assert.equal(a.nextReadyAt,(Math.floor(at/21600000)+1)*21600000);at+=21600000;assert.equal(a.nextReadyAt,0);assert.equal(calls,1);
 }finally{c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
