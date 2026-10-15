import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAmplitudeReader} from './founder-amplitude.mjs';

test('reads only fixed aggregate endpoints, caches, and never returns credentials',async()=>{
 let now=Date.parse('2026-10-13T14:00:00Z'),calls=0;
 const reader=createAmplitudeReader({now:()=>now,readSecret:async()=>'private-test-credential',request:async(url,options)=>{
  calls++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(url.origin,'https://amplitude.com');assert.equal(url.pathname,'/api/2/events/segmentation');
  assert.equal(url.searchParams.get('m'),'totals');assert.equal(url.searchParams.get('start'),'20260914');
  const name=JSON.parse(url.searchParams.get('e')).event_type;
  return new Response(JSON.stringify({data:{series:[[1,1]],seriesCollapsed:[[{value:name==='seite aufgerufen'?2:1}]],xValues:['2026-10-12','2026-10-13']}}));
 }});
 const result=await reader();assert.equal(result.status,'connected');assert.equal(result.pageViews,2);assert.equal(result.dashboardViews,1);assert.equal(calls,2);
 assert.ok(!JSON.stringify(result).includes('private-test-credential'));
 await reader();assert.equal(calls,2);
 now+=900001;await reader();assert.equal(calls,4);
});
test('missing credentials do not send requests or invent zero counts',async()=>{
 const r=await createAmplitudeReader({readSecret:async()=>null,request:()=>{throw Error('unexpected request');}})();
 assert.equal(r.status,'not-configured');assert.equal(r.pageViews,undefined);
});

test('temporary provider failures recover after one minute without repeated requests while waiting',async()=>{
 let now=Date.parse('2026-10-15T11:00:00Z'),failed=true,calls=0;
 const reader=createAmplitudeReader({now:()=>now,readSecret:async()=>'private-test-credential',request:async()=>{
  calls++;if(failed)throw new DOMException('Request timed out','TimeoutError');
  return new Response(JSON.stringify({data:{seriesCollapsed:[[{value:2}]],xValues:['2026-10-15']}}));
 }});
 const first=await reader();assert.equal(first.status,'unavailable');
 const before=calls;now+=59000;await reader();assert.equal(calls,before);
 failed=false;now+=1001;const recovered=await reader();assert.equal(recovered.status,'connected');assert.equal(recovered.pageViews,2);
 const after=calls;now+=60001;await reader();assert.equal(calls,after);
});
test('failed refresh retains previous counts as stale with unchanged data time',async()=>{
 let now=Date.parse('2026-10-13T14:00:00Z'),fail=false,calls=0;
 const reader=createAmplitudeReader({now:()=>now,readSecret:async()=>'private-test-credential',request:async()=>{
  calls++;if(fail)return new Response('',{status:401});
  return new Response(JSON.stringify({data:{series:[[0]],seriesCollapsed:[[{value:0}]],xValues:['2026-10-13']}}));
 }});
 const first=await reader();now+=900001;fail=true;
 const stale=await reader();assert.equal(stale.status,'stale');assert.equal(stale.pageViews,0);assert.equal(stale.observedAt,first.observedAt);assert.equal(stale.reason,'authentication');
 const prior=calls;await reader();assert.equal(calls,prior);
});
test('invalid or oversized provider responses are unavailable, not zero',async()=>{
 for(const body of [JSON.stringify({data:{seriesCollapsed:[[{value:-1}]]}}),'x'.repeat(1048577)]){
  const r=await createAmplitudeReader({readSecret:async()=>'private-test-credential',request:async()=>new Response(body)})();
  assert.equal(r.status,'unavailable');assert.equal(r.pageViews,undefined);
 }
});
