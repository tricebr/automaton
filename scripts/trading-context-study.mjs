import {readFileSync} from 'node:fs';
import Database from 'better-sqlite3';import {createHash} from 'node:crypto';
import {analyzeTradingContext,CONTEXT_RULES,analystKnowledge} from '../src/revenue/long-history/trading-context.ts';
import {estimateResearchCosts} from './trading-cost-model.mjs';import {tariffSummary} from './trading-tariff.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const RULES=Object.freeze({...CONTEXT_RULES,version:'century-context-5',capturePolicy:'5s polling; shared 80-symbol admission; sampled quotes, not tick-complete',maxHoldingMs:7200000,maxRecords:2000,maxOpen:100,comparison:'paired same signal, identical entry/stop/target; context may select no-action; unknown outcomes excluded from both sums',costModel:'current published commission and financing reserve, not historically verified costs; spread in bid/ask, extra slippage 1 spread / stress 2 spreads'});
const quote=(r,now)=>r&&Number.isFinite(r.quoteAt)&&r.quoteAt<=now&&now-r.quoteAt<=15000&&Number.isFinite(r.bid)&&Number.isFinite(r.ask)&&r.bid>0&&r.ask>=r.bid;
export function openContextStudy(file,{clock=Date.now,lessonReader=()=>[],costProfile=tariffSummary()}={}){
 const db=new Database(file);db.pragma('busy_timeout=5000');db.exec('CREATE TABLE IF NOT EXISTS century_context_manifest(id TEXT PRIMARY KEY,start INTEGER NOT NULL,digest TEXT NOT NULL,rules TEXT NOT NULL); CREATE TABLE IF NOT EXISTS century_context_records(id TEXT PRIMARY KEY,account TEXT NOT NULL,server TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,last INTEGER NOT NULL,gap INTEGER NOT NULL,result TEXT);');
 const codeDigest=hash(['trading-context-study.mjs','trading-cost-model.mjs','trading-strategies.mjs','../src/revenue/long-history/trading-context.ts'].map(file=>readFileSync(new URL(file,import.meta.url),'utf8'))),costProfileDigest=hash(costProfile),manifestDigest=hash({rules:RULES,codeDigest,costProfileDigest});
 db.prepare('INSERT OR IGNORE INTO century_context_manifest VALUES(?,?,?,?)').run(RULES.version,clock(),manifestDigest,JSON.stringify({...RULES,codeDigest,costProfileDigest}));
 const manifest=db.prepare('SELECT * FROM century_context_manifest WHERE id=?').get(RULES.version);if(manifest.digest!==manifestDigest){db.close();throw Error('Changed century research rules require a new version');}
 db.prepare("UPDATE century_context_records SET status='retired' WHERE status='open' AND json_extract(payload,'$.context.version')<>?").run(RULES.version);
 const tariff=costProfile;let active=null,samples=[],scanAt=null;
 const observe=db.transaction((m,signals,now,allowNew)=>{
  const a=m?.account;if(typeof a?.identity!=='string'||!a.identity||typeof a.server!=='string'||!a.server||!Number.isFinite(a.observedAt)||a.observedAt>now||now-a.observedAt>15000||!Array.isArray(m.instruments)||!Number.isFinite(now))return;
  active=[a.identity,a.server];const quotes=[...(m.watchQuotes??[]),...m.instruments];
  for(const record of db.prepare("SELECT * FROM century_context_records WHERE account=? AND server=? AND status='open' AND json_extract(payload,'$.context.version')=?").all(...active,RULES.version)){
   const s=JSON.parse(record.payload),q=quotes.find(r=>r.symbol===s.symbol&&quote(r,now));
   if(!q||q.quoteAt<=record.last){if(now>=s.observedAt+RULES.maxHoldingMs){const result={reason:'timeout-no-quote',exitAt:null,recordedAt:now,coverageGap:true,costPending:!Number.isFinite(s.costs.extraR)||!Number.isFinite(s.costs.stressExtraR),baselineR:null,baselineStressR:null,contextR:null,contextStressR:null};db.prepare("UPDATE century_context_records SET status='closed',gap=1,result=? WHERE id=?").run(JSON.stringify(result),record.id);}continue;}
   const gap=!!record.gap||q.quoteAt-record.last>15000,price=s.side==='BUY'?q.bid:q.ask;
   const stop=s.side==='BUY'?price<=s.stop:price>=s.stop,target=s.side==='BUY'?price>=s.target:price<=s.target,timeout=q.quoteAt>=s.observedAt+RULES.maxHoldingMs;
   if(stop||target||timeout){const grossR=(s.side==='BUY'?price-s.entry:s.entry-price)/Math.abs(s.entry-s.stop),costKnown=Number.isFinite(s.costs.extraR)&&Number.isFinite(s.costs.stressExtraR),known=!gap&&costKnown;
    const result={reason:stop?'stop':target?'target':'timeout',exitAt:q.quoteAt,coverageGap:gap,costPending:!costKnown,baselineR:known?grossR-s.costs.extraR:null,baselineStressR:known?grossR-s.costs.stressExtraR:null,contextR:known?(s.selected?grossR-s.costs.extraR:0):null,contextStressR:known?(s.selected?grossR-s.costs.stressExtraR:0):null};
    db.prepare("UPDATE century_context_records SET status='closed',last=?,gap=?,result=? WHERE id=?").run(q.quoteAt,Number(gap),JSON.stringify(result),record.id);
   }else db.prepare('UPDATE century_context_records SET last=?,gap=? WHERE id=?').run(q.quoteAt,Number(gap),record.id);
  }
  let lessons=[];try{lessons=lessonReader().slice(0,20);}catch{}
  samples=m.instruments.slice(0,50).map(row=>{const {eligible,...context}=analyzeTradingContext(row,now,lessons);return {...context,version:RULES.version};});scanAt=now;
  if(!allowNew)return;
  for(const s of signals.slice(0,50)){
   const row=m.instruments.find(r=>r.symbol===s.symbol),context=samples.find(c=>c.symbol===s.symbol);
   if(!context?.valid||!quote(row,now)||!['BUY','SELL'].includes(s.side)||typeof s.signalId!=='string'||![s.entry,s.stop,s.target].every(v=>Number.isFinite(v)&&v>0)||(s.side==='BUY'?!(s.stop<s.entry&&s.entry<s.target):!(s.target<s.entry&&s.entry<s.stop)))continue;
   if(row.closedBars.at(-1).time*1000+300000<=manifest.start||row.quoteAt<manifest.start||row.quoteAt<row.closedBars.at(-1).time*1000+300000)continue;
   if(Math.abs(s.entry-(s.side==='BUY'?row.ask:row.bid))>Math.max(1e-9,s.entry*1e-10))continue;
   const id=hash([...active,RULES.version,s.signalId]);if(db.prepare('SELECT 1 FROM century_context_records WHERE id=?').get(id))continue;
   if(db.prepare('SELECT COUNT(*) n FROM century_context_records').get().n>=RULES.maxRecords)break;
   if(db.prepare("SELECT COUNT(*) n FROM century_context_records WHERE account=? AND server=? AND status='open' AND json_extract(payload,'$.context.version')=?").get(...active,RULES.version).n>=RULES.maxOpen)break;
   const selected=s.side==='BUY'?context.allowLong:context.allowShort,costs=estimateResearchCosts({row,side:s.side,entry:s.entry,stop:s.stop,profile:tariff,now});
   db.prepare('INSERT INTO century_context_records VALUES(?,?,?,?,?,?,0,NULL)').run(id,...active,'open',JSON.stringify({...s,observedAt:row.quoteAt,selected,context,contextInput:{bid:row.bid,ask:row.ask,quoteAt:row.quoteAt,closedBars:row.closedBars.slice(-CONTEXT_RULES.bars)},costs,modelDigest:manifest.digest,costProfileDigest}),row.quoteAt);
  }
 }).immediate;
 return {observe(m,signals,now=clock(),allowNew=true){observe(m,signals,now,allowNew);},watch(account=null){const scope=account&&typeof account.identity==='string'&&typeof account.server==='string'?[account.identity,account.server]:active;return scope?[...new Set(db.prepare("SELECT payload FROM century_context_records WHERE account=? AND server=? AND status='open' AND json_extract(payload,'$.context.version')=?").all(...scope,RULES.version).map(r=>JSON.parse(r.payload).symbol))]:[];},snapshot(now=clock()){
  const records=active?db.prepare("SELECT * FROM century_context_records WHERE account=? AND server=? AND json_extract(payload,'$.context.version')=?").all(...active,RULES.version):[],closed=records.filter(r=>r.status==='closed').map(r=>JSON.parse(r.result)),known=closed.filter(r=>r.baselineR!==null&&r.contextR!==null),sum=key=>known.length?known.reduce((n,r)=>n+r[key],0):null;
  const baselineR=sum('baselineR'),contextR=sum('contextR');return {version:RULES.version,rulesDigest:manifest.digest,codeDigest,costProfileDigest,startedAt:manifest.start,scanAt,stale:scanAt===null||now-scanAt>15000||now<scanAt,knowledgeReferences:analystKnowledge().length,requestedYears:100,checkedProducts:samples.length,usableProducts:samples.filter(c=>c.valid).length,samples:[...samples].sort((a,b)=>Number(b.valid)-Number(a.valid)).slice(0,12),comparison:{enrolled:records.length,open:records.filter(r=>r.status==='open').length,filtered:records.filter(r=>!JSON.parse(r.payload).selected).length,pairedKnown:known.length,unknown:closed.length-known.length,baselineR,contextR,baselineStressR:sum('baselineStressR'),contextStressR:sum('contextStressR'),differenceR:known.length?contextR-baselineR:null},rules:RULES,archiveFull:db.prepare('SELECT COUNT(*) n FROM century_context_records').get().n>=RULES.maxRecords,profitabilityProven:false,liveAuthorized:false,netProfit:null,limitation:'Frischer paarweiser Forschungsvergleich mit identischen Preisen und Kostenannahmen. Kontext kann Nichtstun wählen. Kurslücken und fehlende Kosten schließen beide Ergebnisse aus dem bestätigten Teilvergleich aus. Keine Broker-Fills, kein Kontogewinn; Nachrichten, Markttiefe und tatsächliche Slippage unbestätigt.'};
 },close(){db.close();}};
}
