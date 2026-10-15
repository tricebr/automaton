import {estimateResearchCosts} from './trading-cost-model.mjs';
import {tariffSummary} from './trading-tariff.mjs';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {evaluateStrategy} from './trading-strategies.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const RULES=Object.freeze({version:'forward-loss-reduction-3',capturePolicy:'5s polling; shared 80-symbol admission; 15s sampled quote-gap limit unchanged',maxHoldingMs:7200000,maxRecords:10000,maxOpen:100,maxSpreadRisk:.1,atrMultiplier:1.5,profiles:['baseline','spread','trend','atr','combined'],costScenario:'Executable bid/ask includes spread; additional slippage 1 spread normal / 2 spreads stress. Published Forex commission; 3 charged-day current swap debit reserve, doubled under stress. Other cost models unavailable; actual costs remain unverified.'});
const validQuote=(r,now)=>r&&Number.isFinite(r.quoteAt)&&r.quoteAt<=now+1000&&now-r.quoteAt<=15000&&Number.isFinite(r.bid)&&Number.isFinite(r.ask)&&r.bid>0&&r.ask>=r.bid;
export function openStrategyOptimization(file,clock=Date.now){
 const db=new Database(file);db.pragma('busy_timeout=5000');
 db.exec('CREATE TABLE IF NOT EXISTS strategy_opt_manifest(id TEXT PRIMARY KEY,start INTEGER NOT NULL,rules TEXT NOT NULL,digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS strategy_opt_records(id TEXT PRIMARY KEY,account TEXT NOT NULL,server TEXT NOT NULL,version TEXT NOT NULL,profile TEXT NOT NULL,symbol TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,last INTEGER NOT NULL,gap INTEGER NOT NULL DEFAULT 0,result TEXT);');
 db.prepare('INSERT OR IGNORE INTO strategy_opt_manifest VALUES(?,?,?,?)').run(RULES.version,clock(),JSON.stringify(RULES),hash(RULES));
 const accountTariff=tariffSummary();const manifest=db.prepare('SELECT * FROM strategy_opt_manifest WHERE id=?').get(RULES.version);if(manifest.digest!==hash(RULES)){db.close();throw Error('Research rules changed without new version');}let active=null;
 // Version changes end old hypothetical observations without fabricating a fill or PnL.
 db.prepare("UPDATE strategy_opt_records SET status='retired',result=NULL WHERE version<>? AND status='open'").run(RULES.version);
 const observe=db.transaction((m,now,allowNew)=>{
  const a=m?.account;if(typeof a?.identity!=='string'||!a.identity||typeof a.server!=='string'||!a.server||!Number.isFinite(now)||!Number.isFinite(a.observedAt)||a.observedAt>now+1000||now-a.observedAt>15000)return;active=[a.identity,a.server];
  const quotes=[...(m.watchQuotes??[]),...(m.instruments??[])];
  for(const record of db.prepare("SELECT * FROM strategy_opt_records WHERE account=? AND server=? AND version=? AND status='open'").all(...active,RULES.version)){
   const s=JSON.parse(record.payload),q=quotes.find(q=>q.symbol===record.symbol&&validQuote(q,now));
   if(!q||q.quoteAt<=record.last){if(now>=s.observedAt+RULES.maxHoldingMs){const result={reason:'timeout-no-quote',exitAt:null,recordedAt:now,grossR:null,scenarioR:null,stressScenarioR:null,costPending:!Number.isFinite(s.costModel?.extraR),coverageGap:true,netProfit:null,costsVerified:false};db.prepare("UPDATE strategy_opt_records SET status='closed',gap=1,result=? WHERE id=?").run(JSON.stringify(result),record.id);}continue;}const gap=!!record.gap||q.quoteAt-record.last>15000;
   const price=s.side==='BUY'?q.bid:q.ask,stop=s.side==='BUY'?price<=s.stop:price>=s.stop,target=s.side==='BUY'?price>=s.target:price<=s.target,timeout=q.quoteAt>=s.observedAt+RULES.maxHoldingMs;
   if(stop||target||timeout){const grossR=(s.side==='BUY'?price-s.entry:s.entry-price)/Math.abs(s.entry-s.stop),slip=s.spread/Math.abs(s.entry-s.stop),result={reason:stop?'stop':target?'target':'timeout',grossR,scenarioR:Number.isFinite(s.costModel?.extraR)?grossR-s.costModel.extraR:null,stressScenarioR:Number.isFinite(s.costModel?.stressExtraR)?grossR-s.costModel.stressExtraR:null,costPending:!Number.isFinite(s.costModel?.extraR),coverageGap:gap,exitAt:q.quoteAt,netProfit:null,costsVerified:false};db.prepare("UPDATE strategy_opt_records SET status='closed',last=?,gap=?,result=? WHERE id=?").run(q.quoteAt,Number(gap),JSON.stringify(result),record.id);}
   else db.prepare('UPDATE strategy_opt_records SET last=?,gap=? WHERE id=?').run(q.quoteAt,Number(gap),record.id);
  }
  if(!allowNew||db.prepare('SELECT COUNT(*) n FROM strategy_opt_records').get().n>=RULES.maxRecords)return;
  const candidate={id:'numaron-breakout20-v1',rules:{kind:'breakout20'},source:{verified:true,reference:'scripts/trading-strategies.mjs'}};
  for(const s of evaluateStrategy(candidate,m,now)){
   const row=m.instruments.find(r=>r.symbol===s.symbol),b=row.closedBars,last=b.at(-1);
   if(!validQuote(row,now)||row.quoteAt<last.time*1000+300000||row.quoteAt<manifest.start||![s.entry,s.stop,s.target].every(Number.isFinite)||last.time*1000+300000<=manifest.start||b.some((x,i)=>i&&x.time-b[i-1].time!==300))continue;
   const spread=row.ask-row.bid;
   for(const profile of RULES.profiles){
    if(db.prepare('SELECT COUNT(*) n FROM strategy_opt_records').get().n>=RULES.maxRecords)return;
    const id=hash([...active,RULES.version,profile,s.signalId]);if(db.prepare('SELECT 1 FROM strategy_opt_records WHERE id=?').get(id))continue;
    const p={...s,strategyVersion:RULES.version+':'+profile,spread,registeredAt:now,newsValidation:false};let reason=null;
    if(profile==='trend'||profile==='combined'){
     if(b.length<61)reason='trend-data-missing';else{const avg=x=>x.reduce((n,v)=>n+v.close,0)/x.length,trend=avg(b.slice(-11,-1))-avg(b.slice(-51,-11));if(s.side==='BUY'?trend<=0:trend>=0)reason='trend-mismatch';}
    }
    if(profile==='atr'||profile==='combined'){
     const parts=b.slice(-15),atr=parts.slice(1).reduce((n,x,i)=>n+Math.max(x.high-x.low,Math.abs(x.high-parts[i].close),Math.abs(x.low-parts[i].close)),0)/14;
     const distance=Math.max(Math.abs(s.entry-s.stop),RULES.atrMultiplier*atr);p.stop=s.side==='BUY'?s.entry-distance:s.entry+distance;p.target=s.side==='BUY'?s.entry+2*distance:s.entry-2*distance;
    }
    if((profile==='spread'||profile==='combined')&&spread/Math.abs(p.entry-p.stop)>RULES.maxSpreadRisk)reason='spread-too-high';
    if(![p.entry,p.stop,p.target].every(Number.isFinite)||!(p.stop>0&&p.target>0))reason='invalid-geometry';
    p.costModel=estimateResearchCosts({row,side:p.side,entry:p.entry,stop:p.stop,profile:accountTariff,now});
    if(!reason&&db.prepare("SELECT 1 FROM strategy_opt_records WHERE account=? AND server=? AND version=? AND profile=? AND symbol=? AND status='open'").get(...active,RULES.version,profile,s.symbol))continue;
    if(!reason&&db.prepare("SELECT COUNT(*) n FROM strategy_opt_records WHERE status='open'").get().n>=RULES.maxOpen)continue;
    db.prepare('INSERT INTO strategy_opt_records VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id,...active,RULES.version,profile,s.symbol,reason?'filtered':'open',JSON.stringify({...p,filterReason:reason}),row.quoteAt,0);
   }
  }
 }).immediate;
 return {observe(m,now=clock(),allowNew=true){observe(m,now,allowNew);},watch(account=null){const scope=account&&typeof account.identity==='string'&&typeof account.server==='string'?[account.identity,account.server]:active;return scope?[...new Set(db.prepare("SELECT symbol FROM strategy_opt_records WHERE account=? AND server=? AND version=? AND status='open'").all(...scope,RULES.version).map(x=>x.symbol))]:[];},snapshot(now=clock()){
  const records=active?db.prepare('SELECT * FROM strategy_opt_records WHERE account=? AND server=? AND version=?').all(...active,RULES.version):[];
  const variants=RULES.profiles.map(id=>{const rows=records.filter(r=>r.profile===id),closed=rows.filter(r=>r.status==='closed').map(r=>JSON.parse(r.result)),known=closed.filter(r=>!r.coverageGap&&!r.costPending),filtered=rows.filter(r=>r.status==='filtered');return {id,open:rows.filter(r=>r.status==='open').length,closed:closed.length,known:known.length,unknown:closed.filter(r=>r.coverageGap).length,costPending:closed.filter(r=>r.costPending).length,filtered:filtered.length,stop:closed.filter(r=>r.reason==='stop').length,timeout:closed.filter(r=>r.reason==='timeout').length,scenarioR:known.reduce((n,r)=>n+r.scenarioR,0),stressScenarioR:known.reduce((n,r)=>n+r.stressScenarioR,0),filterReasons:Object.fromEntries([...new Set(filtered.map(r=>JSON.parse(r.payload).filterReason))].map(k=>[k,filtered.filter(r=>JSON.parse(r.payload).filterReason===k).length]))};});
  const eligible=variants.filter(v=>v.known>=100&&v.scenarioR>0&&v.stressScenarioR>0&&now-manifest.start>=30*86400000).sort((a,b)=>b.stressScenarioR/b.known-a.stressScenarioR/a.known);
  return {version:RULES.version,startedAt:manifest.start,rulesDigest:manifest.digest,rules:RULES,total:records.length,archiveFull:db.prepare('SELECT COUNT(*) n FROM strategy_opt_records').get().n>=RULES.maxRecords,variants,researchLeader:eligible[0]?.id??null,netProfit:null,executionEnabled:false,profitabilityProven:false,costsVerified:false,independentValidation:false,limitation:'Neue Beobachtungen nach festen Regeln; keine Broker-Ausführungen. Unbekannte Ausgänge und Kurslücken separat. Aktuelle Swap-Reserve und veröffentlichte Standardgebühren sind Szenarien; swapfreie Verwaltungsgebühren, Vertragszuordnung und echte Slippage offen. Fehlende Kosten ergeben keine Nullkosten. Nachrichtenwirkung nicht validiert. Ein Forschungsfavorit ist keine Freigabe.'};
 },close(){db.close();}};
}
