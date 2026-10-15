import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openForwardObservation} from './trading-forward.mjs';
const signal={signalId:'s',strategyVersion:'v',symbol:'TEST',side:'BUY',entry:100,stop:90,target:120,observedAt:1000,expiresAt:16000};
const market=(time,bid,ask=bid+1)=>({account:{identity:'a',server:'b',observedAt:time},instruments:[{symbol:'TEST',quoteAt:time,bid,ask}]});
test('reopen persists deduplication and account switches isolate the displayed evidence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'numaron-forward-')),file=join(dir,'evidence.db');let o=openForwardObservation(file);
 try{o.observe(market(1000,99),[signal],1000);o.close();o=openForwardObservation(file);o.observe(market(2000,99),[signal],2000);assert.equal(o.snapshot(2000).totalOpen,1);
 const other=market(3000,121);other.account.identity='other';o.observe(other,[],3000);assert.equal(o.snapshot(3000).totalOpen,0);assert.equal(o.snapshot(3000).totalClosed,0);
 o.observe(market(4000,99),[],4000);assert.equal(o.snapshot(40000).open[0].stale,true);assert.equal(o.snapshot(40000).open[0].coverageGap,true);assert.equal(o.snapshot(40000).open[0].lastObservedAt,4000);
 }finally{o.close();rmSync(dir,{recursive:true,force:true});}
});
test('forward bounds open evidence per symbol and never admits a hidden unwatchable backlog',()=>{
 const o=openForwardObservation(':memory:');try{o.observe(market(1000,99),Array.from({length:105},(_,i)=>({...signal,signalId:'s'+i})),1000);assert.equal(o.snapshot(1000).totalOpen,1);assert.deepEqual(o.watch(),['TEST']);o.observe(market(2000,121),[],2000);assert.equal(o.snapshot(2000).totalClosed,1);}finally{o.close();}
});
test('forward expires at two hours, keeps real gaps unknown, and pause still observes exits',()=>{
 const o=openForwardObservation(':memory:');try{o.observe(market(1000,99),[signal],1000,false);assert.equal(o.snapshot(1000).totalOpen,0);o.observe(market(1000,99),[signal],1000);o.observe(market(7201000,99),[],7201000,false);assert.equal(o.snapshot(7201000).totalOpen,0);assert.equal(o.snapshot(7201000).closed[0].reason,'timeout');assert.equal(o.snapshot(7201000).closed[0].coverageGap,true);}finally{o.close();}
});
test('forward observation deduplicates and reports gross R without inventing net profit',()=>{
 const o=openForwardObservation(':memory:');try{o.observe(market(1000,99),[signal],1000);o.observe(market(2000,105),[signal],2000);assert.equal(o.snapshot().open.length,1);o.observe(market(3000,121),[],3000);const s=o.snapshot();assert.equal(s.closed.length,1);assert.equal(s.closed[0].grossR,2.1);assert.equal(s.closed[0].netProfit,null);assert.equal(s.liveAuthorized,false);o.observe(market(4000,100),[signal],4000);assert.equal(o.snapshot().open.length,0);}finally{o.close();}
});
test('stale quotes cannot close observations; gaps are explicitly disclosed',()=>{
 const o=openForwardObservation(':memory:');try{o.observe(market(1000,99),[signal],1000);o.observe(market(1000,80),[],30000);assert.equal(o.snapshot().open.length,1);o.observe(market(40000,80),[],40000);assert.equal(o.snapshot().closed[0].grossR,-2);assert.equal(o.snapshot().closed[0].coverageGap,true);}finally{o.close();}
});
test('sell outcomes use ask and reject malformed signal geometry',()=>{
 const o=openForwardObservation(':memory:');try{o.observe(market(1000,100),[{...signal,side:'SELL',stop:110,target:80}],1000);o.observe(market(2000,78,79),[],2000);assert.equal(o.snapshot().closed[0].grossR,2.1);o.observe(market(3000,100),[{...signal,signalId:'bad',stop:110}],3000);assert.equal(o.snapshot().open.length,0);}finally{o.close();}
});

test('missing closing quotes expire as unknown and release the reserved symbol',()=>{
 const o=openForwardObservation(':memory:');try{o.observe(market(1000,99),[signal],1000);o.observe({account:{identity:'a',server:'b'},instruments:[]},[],7201001,false);const v=o.snapshot(7201001);assert.equal(v.totalOpen,0);assert.deepEqual(o.watch(),[]);assert.equal(v.closed[0].grossR,null);assert.equal(v.closed[0].exitPrice,null);assert.equal(v.closed[0].coverageGap,true);}finally{o.close();}
});
