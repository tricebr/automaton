import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {walkForwardPaper} from '../src/revenue/paper-trading.ts';

export const REPLAY_RULES=Object.freeze({strategy:'cash-breakout20-long-v1',trainBars:25,testBars:25,riskFraction:.01,initialCapitalCents:1000000,feeBps:10,slippageBps:10,minimumFeeCents:100});
export function replayCashCandidate(row){
 if(!row?.symbol||row.costTerms?.contractSize!==1||!['USD','EUR','CHF'].includes(row.costTerms?.profitCurrency))throw Error('Unsupported cash comparator contract');
 const raw=row.closedBars;
 if(!Array.isArray(raw)||raw.length<75||raw.some((b,i)=>!['time','open','high','low','close'].every(k=>Number.isFinite(b[k])&&b[k]>0)||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.high<b.low||(i&&b.time<=raw[i-1].time)))throw Error('Invalid historical bars');
 const bars=raw.map(b=>({time:Math.trunc(b.time),open:Math.ceil(b.open*100),high:Math.ceil(b.high*100),low:Math.floor(b.low*100),close:Math.floor(b.close*100)}));
 const friction={feeBps:10,slippageBps:10,minimumFeeCents:100};
 const fit=()=> (past,nextOpen)=>{
  if(past.length<25)return null;const last=past.at(-1),prior=past.slice(-21,-1),stop=Math.min(...past.slice(-3).map(b=>b.low));
  if(last.close<=Math.max(...prior.map(b=>b.high))||nextOpen<=stop)return null;
  return {currency:row.costTerms.profitCurrency,symbol:row.symbol,thesis:'Abgeschlossener 20-Kerzen-Ausbruch, feste Regeln vor dem Test.',entryCents:nextOpen,stopCents:stop,targetsCents:[nextOpen+2*(nextOpen-stop)],riskFraction:.01,exitRule:'Stop vor Ziel bei unbekannter Intrabar-Reihenfolge; spätestens Ende des Testfensters.'};
 };
 const run=f=>walkForwardPaper(bars,25,25,1000000,f,fit);
 const result=run(friction),stress=run({feeBps:20,slippageBps:20,minimumFeeCents:200});
 return {mode:'paper-cash-comparator',strategyVersion:REPLAY_RULES.strategy,symbol:row.symbol,currency:row.costTerms.profitCurrency,datasetDigest:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),source:'MT5 closed M5 bars',rules:REPLAY_RULES,friction,costsVerified:false,liveAuthorized:false,independentStrategyProven:false,result,stress,limitations:['Virtuelles Startkapital 10 000 pro Test; keine echten Einnahmen.','Cash-Vergleich mit ganzen Einheiten, nur Long; keine Simulation der CFD-Margin oder Short-Finanzierung.','Gebühren und Slippage sind feste Forschungsannahmen, keine bestätigten Brokerkosten.','Keine Finanzierung eines Cash-Kaufs; dieses Modell gilt nicht für gehebelte Brokerpositionen.','100 M5-Kerzen sind kein ausreichender unabhängiger Profitabilitätsnachweis.']};
}

export function openReplayResearch(file){
 const db=new Database(file);db.pragma('busy_timeout=5000');db.exec('CREATE TABLE IF NOT EXISTS trading_replay(id TEXT PRIMARY KEY,account TEXT NOT NULL,server TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,raw TEXT NOT NULL)');let active=null,observedDay=null;
 return {observe(m,now=Date.now()){if(!m?.account?.identity||!m.account.server)return;active=[m.account.identity,m.account.server];observedDay=Math.floor(now/86400000)*86400000;const dayCount=()=>db.prepare('SELECT COUNT(*) n FROM trading_replay WHERE account=? AND server=? AND at>=? AND at<?').get(...active,observedDay,observedDay+86400000).n;if(dayCount()>=1000)return;
  for(const row of m.instruments??[]){if(dayCount()>=1000)break;if(!row.capability)continue;const recent=db.prepare("SELECT at FROM trading_replay WHERE account=? AND server=? AND json_extract(payload,'$.symbol')=? ORDER BY at DESC LIMIT 1").get(...active,row.symbol);if(recent&&now-recent.at<3600000)continue;let report;try{report=replayCashCandidate(row);}catch{continue;}const id=createHash('sha256').update(JSON.stringify([...active,report.strategyVersion,report.datasetDigest,report.symbol])).digest('hex');db.prepare('INSERT OR IGNORE INTO trading_replay VALUES(?,?,?,?,?,?)').run(id,...active,now,JSON.stringify(report),JSON.stringify(row.closedBars));}
 },snapshot(now=Date.now()){if(!active)return {reports:[],totalReports:0,independentStrategyProven:false};const n=db.prepare('SELECT COUNT(*) n FROM trading_replay WHERE account=? AND server=?').get(...active).n;const rows=db.prepare('SELECT payload FROM trading_replay WHERE account=? AND server=? ORDER BY at DESC,id LIMIT 5').all(...active);return {totalReports:n,archiveFull:db.prepare('SELECT COUNT(*) n FROM trading_replay WHERE account=? AND server=? AND at>=? AND at<?').get(...active,Math.floor(now/86400000)*86400000,Math.floor(now/86400000)*86400000+86400000).n>=1000,archiveLimitScope:'1000 per UTC day, at least 1 hour between snapshots per symbol; archived days retained',independentStrategyProven:false,reports:rows.map(r=>{const p=JSON.parse(r.payload);return {symbol:p.symbol,currency:p.currency,strategyVersion:p.strategyVersion,datasetDigest:p.datasetDigest,mode:p.mode,netPnlCents:p.result.netPnlCents,stressNetPnlCents:p.stress.netPnlCents,trades:p.result.trades.length,initialCapitalCents:p.result.initialEquityCents,costsVerified:false,limitations:p.limitations};})};},close(){db.close();}};
}
