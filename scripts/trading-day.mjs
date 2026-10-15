import Database from 'better-sqlite3';
import {zurichDay} from './trading-risk.mjs';
export function openTradingDay(file){
 const db=new Database(file);db.pragma('busy_timeout=5000');
 // Legacy unbound rows are retained but never reused across broker servers.
 db.exec('CREATE TABLE IF NOT EXISTS trading_days_v2(account TEXT NOT NULL,server TEXT NOT NULL,currency TEXT NOT NULL,starts INTEGER NOT NULL,ends INTEGER NOT NULL,equity REAL NOT NULL,observed INTEGER NOT NULL,method TEXT NOT NULL,PRIMARY KEY(account,server,currency,starts))');
 return {observe(m,now=Date.now()){
  const p=zurichDay(now),a=m?.account;
  const invalid=reason=>({...p,account:a?.identity,server:a?.server,currency:a?.currency,verified:false,reason});
  if(!a?.identity||!a.server||!a.currency||!(a.equity>0)||!Number.isFinite(a.observedAt)||now-a.observedAt>1000||a.observedAt>now)return invalid('Aktuelle kontogebundene Equity fehlt.');
  if(!Array.isArray(m.cashFlows)||m.flowWindow?.startsAt!==p.startsAt||m.flowWindow?.endsAt!==p.endsAt||m.cashFlows.some(x=>!x||!['external','trading'].includes(x.kind)||!Number.isFinite(x.amount)))return invalid('Vollständige Geldbewegungen fehlen.');
  const key=[a.identity,a.server,a.currency,p.startsAt],get=()=>db.prepare('SELECT * FROM trading_days_v2 WHERE account=? AND server=? AND currency=? AND starts=?').get(...key);
  let row=get();const h=m.dayHistory;
  const emptyProof=h?.complete===true&&h.windowVerified===true&&(h.wideIntervalEmpty===true||h.dayIntervalEmpty===true)&&h.account===a.identity&&h.server===a.server&&h.source==='MT5 history_deals_get + history_deals_total'&&h.flowWindow?.startsAt===p.startsAt&&h.flowWindow?.endsAt===p.endsAt&&Number.isFinite(h.observedAt)&&now-h.observedAt<=1000&&h.observedAt<=now&&Array.isArray(m.positions)&&m.positions.length===0&&m.cashFlows.length===0&&a.credit===0&&a.profit===0&&a.balance===a.equity;
  const midnight=a.observedAt-p.startsAt>=0&&a.observedAt-p.startsAt<=1000;
  if(!row&&(emptyProof||midnight)){
   const flow=m.cashFlows.filter(x=>x.kind==='external').reduce((s,x)=>s+x.amount,0);
   if(flow!==0)return invalid('Geldbewegung während der Tagesstartaufnahme.');
   db.prepare('INSERT OR IGNORE INTO trading_days_v2 VALUES(?,?,?,?,?,?,?,?)').run(a.identity,a.server,a.currency,p.startsAt,p.endsAt,a.equity,a.observedAt,emptyProof?'flat-account-empty-history':'midnight-observation');row=get();
  }
  if(!row)return invalid('Bestätigte Equity am Zürich-Tagesstart fehlt.');
  return {...p,account:a.identity,server:a.server,currency:a.currency,openingEquity:row.equity,method:row.method,netExternalFlow:m.cashFlows.filter(x=>x.kind==='external').reduce((s,x)=>s+x.amount,0),verified:true};
 },close(){db.close();}};
}
