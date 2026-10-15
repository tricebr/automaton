import Database from 'better-sqlite3';

// Forward quote observations, never broker fills or authenticated net returns.
export function openForwardObservation(file){
 let active=null;const db=new Database(file);db.pragma('busy_timeout=5000');
 db.exec('CREATE TABLE IF NOT EXISTS trading_forward(id TEXT PRIMARY KEY,account TEXT NOT NULL,server TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,last INTEGER NOT NULL,gap INTEGER NOT NULL DEFAULT 0,outcome TEXT)');
 const observe=db.transaction((market,signals,now,allowNew)=>{
  const a=market?.account;if(!a?.identity||!a.server)return;active=[a.identity,a.server];
  const quote=symbol=>[...(market.watchQuotes??[]),...(market.instruments??[])].find(r=>r.symbol===symbol&&Number.isFinite(r.quoteAt)&&now-r.quoteAt<=15000&&r.quoteAt<=now+1000&&r.bid>0&&r.ask>=r.bid);
  for(const row of db.prepare("SELECT * FROM trading_forward WHERE status='open' AND account=? AND server=?").all(a.identity,a.server)){
   const s=JSON.parse(row.payload),q=quote(s.symbol);
   if(!q||q.quoteAt<=row.last){if(now>=s.observedAt+7200000){const result={...s,reason:'timeout-no-quote',exitAt:null,recordedAt:now,exitPrice:null,grossR:null,netProfit:null,coverageGap:true,kind:'quote-observation',costsVerified:false};db.prepare("UPDATE trading_forward SET status='closed',gap=1,outcome=? WHERE id=?").run(JSON.stringify(result),row.id);}continue;}
   const gap=!!row.gap||q.quoteAt-row.last>15000,price=s.side==='BUY'?q.bid:q.ask;
   const stopped=s.side==='BUY'?price<=s.stop:price>=s.stop,target=s.side==='BUY'?price>=s.target:price<=s.target;
   const timeout=q.quoteAt>=s.observedAt+7200000;
   if(stopped||target||timeout){const grossR=(s.side==='BUY'?price-s.entry:s.entry-price)/Math.abs(s.entry-s.stop);const result={...s,exitAt:q.quoteAt,exitPrice:price,reason:stopped?'stop':target?'target':'timeout',grossR,netProfit:null,coverageGap:gap,kind:'quote-observation',costsVerified:false};db.prepare("UPDATE trading_forward SET status='closed',last=?,gap=?,outcome=? WHERE id=?").run(q.quoteAt,Number(gap),JSON.stringify(result),row.id);}
   else db.prepare('UPDATE trading_forward SET last=?,gap=? WHERE id=?').run(q.quoteAt,Number(gap),row.id);
  }
  if(!allowNew)return;
  for(const s of signals??[]){
   if(!s?.signalId||!s.strategyVersion||!quote(s.symbol)||!Number.isFinite(s.observedAt)||s.observedAt>now||now-s.observedAt>15000||!(s.expiresAt>now)||![s.entry,s.stop,s.target].every(x=>Number.isFinite(x)&&x>0)||!['BUY','SELL'].includes(s.side))continue;
   if(s.side==='BUY'?! (s.stop<s.entry&&s.target>s.entry):!(s.stop>s.entry&&s.target<s.entry))continue;
   if(db.prepare("SELECT 1 FROM trading_forward WHERE account=? AND server=? AND status='open' AND json_extract(payload,'$.symbol')=?").get(a.identity,a.server,s.symbol)||db.prepare("SELECT COUNT(*) n FROM trading_forward WHERE account=? AND server=? AND status='open'").get(a.identity,a.server).n>=80)continue;
   const q=quote(s.symbol);db.prepare("INSERT OR IGNORE INTO trading_forward(id,account,server,payload,status,last) VALUES(?,?,?,?,'open',?)").run([a.identity,a.server,s.signalId].join(':'),a.identity,a.server,JSON.stringify(s),q.quoteAt);
  }
 }).immediate;
 return {observe(market,signals=[],now=Date.now(),allowNew=true){observe(market,signals,now,allowNew);},watch(account=null){const scope=account&&typeof account.identity==='string'&&typeof account.server==='string'?[account.identity,account.server]:active;return scope?[...new Set(db.prepare("SELECT payload FROM trading_forward WHERE account=? AND server=? AND status='open'").all(...scope).map(r=>JSON.parse(r.payload).symbol))]:[];},snapshot(now=Date.now()){
 const base={kind:'forward-observation',liveAuthorized:false,netProfit:null,open:[],closed:[],totalOpen:0,totalClosed:0,disclaimer:'Beobachtete Kurse, keine ausgeführten Trades. Gebühren und Finanzierung fehlen; Datenlücken können zwischenzeitliche Stop-Berührungen verdecken. Kein Profitabilitätsnachweis.'};
 if(!active)return base;
 const rows=status=>db.prepare('SELECT payload,outcome,gap,last FROM trading_forward WHERE account=? AND server=? AND status=? ORDER BY last DESC LIMIT 100').all(...active,status);
 const count=status=>db.prepare('SELECT COUNT(*) n FROM trading_forward WHERE account=? AND server=? AND status=?').get(...active,status).n;
 return {...base,totalOpen:count('open'),totalClosed:count('closed'),open:rows('open').map(x=>({...JSON.parse(x.payload),lastObservedAt:x.last,stale:now-x.last>15000,coverageGap:!!x.gap||now-x.last>15000})),closed:rows('closed').map(x=>JSON.parse(x.outcome))};
 },close(){db.close();}};
}
