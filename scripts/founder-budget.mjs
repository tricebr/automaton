import Database from 'better-sqlite3';
export const FOUNDER_LIMITS=Object.freeze({currency:'CHF',periodRappen:15000,dailyRappen:750,taskRappen:200,periodDays:30,maxWorkers:4,timeZone:'Europe/Zurich'});
const day=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:FOUNDER_LIMITS.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
const label=x=>typeof x==='string'&&/^[\w:./-]{1,200}$/.test(x);
const money=x=>Number.isSafeInteger(x)&&x>=0;
export function openFounderBudget(file){
 const db=new Database(file);db.pragma('journal_mode=WAL');db.pragma('busy_timeout=5000');
 db.exec(`CREATE TABLE IF NOT EXISTS founder_budget(id INTEGER PRIMARY KEY CHECK(id=1),start_ms INTEGER NOT NULL,authorization TEXT NOT NULL,last_ms INTEGER NOT NULL,halted INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS founder_reservations(id TEXT PRIMARY KEY,root_task TEXT NOT NULL,max_cost INTEGER NOT NULL,actual_cost INTEGER,day TEXT NOT NULL,receipt TEXT);`);
 const state=()=>db.prepare('SELECT * FROM founder_budget WHERE id=1').get();
 function totals(now){return db.prepare(`SELECT COALESCE(SUM(actual_cost),0) spent,COALESCE(SUM(CASE WHEN actual_cost IS NULL THEN max_cost ELSE 0 END),0) held,COALESCE(SUM(CASE WHEN day=? THEN actual_cost ELSE 0 END),0) daily FROM founder_reservations`).get(day(now));}
 return {
  activate:db.transaction(({startAt,authorizationRef})=>{if(!Number.isSafeInteger(startAt)||!label(authorizationRef))throw Error('Invalid activation');const s=state();if(s){if(s.start_ms!==startAt||s.authorization!==authorizationRef)throw Error('Immutable activation');return;}db.prepare('INSERT INTO founder_budget(id,start_ms,authorization,last_ms) VALUES(1,?,?,?)').run(startAt,authorizationRef,startAt);}).immediate,
  reserve:db.transaction(({id,rootTaskId,maxCostRappen,now=Date.now()})=>{
   if(!label(id)||!label(rootTaskId)||!money(maxCostRappen)||!Number.isSafeInteger(now))throw Error('Invalid reservation');
   const s=state();if(!s)throw Error('Budget inactive');if(s.halted)throw Error('Budget halted');if(now<s.last_ms||now<s.start_ms)throw Error('Clock reversal');if(now>=s.start_ms+30*86400000)throw Error('Budget expired');
   const old=db.prepare('SELECT * FROM founder_reservations WHERE id=?').get(id);if(old){if(old.root_task!==rootTaskId||old.max_cost!==maxCostRappen)throw Error('Conflicting reservation');return {id,duplicate:true,settled:old.actual_cost!==null};}
   const t=totals(now),root=db.prepare('SELECT COALESCE(SUM(COALESCE(actual_cost,max_cost)),0) n FROM founder_reservations WHERE root_task=?').get(rootTaskId).n;
   if(t.spent+t.held+maxCostRappen>15000)throw Error('Budget period limit');if(t.daily+t.held+maxCostRappen>750)throw Error('Budget daily limit');if(root+maxCostRappen>200)throw Error('Budget task limit');
   db.prepare('INSERT INTO founder_reservations(id,root_task,max_cost,day) VALUES(?,?,?,?)').run(id,rootTaskId,maxCostRappen,day(now));db.prepare('UPDATE founder_budget SET last_ms=? WHERE id=1').run(now);return {id,duplicate:false,settled:false};
  }).immediate,
  settle:db.transaction(({id,actualCostRappen,evidenceRef})=>{if(!label(id)||!money(actualCostRappen)||!label(evidenceRef))throw Error('Invalid receipt');const r=db.prepare('SELECT * FROM founder_reservations WHERE id=?').get(id);if(!r)throw Error('Reservation missing');if(r.actual_cost!==null){if(r.actual_cost!==actualCostRappen||r.receipt!==evidenceRef)throw Error('Conflicting receipt');return;}db.prepare('UPDATE founder_reservations SET actual_cost=?,receipt=? WHERE id=?').run(actualCostRappen,evidenceRef,id);if(actualCostRappen>r.max_cost)db.prepare('UPDATE founder_budget SET halted=1 WHERE id=1').run();}).immediate,
  snapshot(now=Date.now()){const s=state(),t=totals(now);return {...FOUNDER_LIMITS,active:!!s&&now>=s.start_ms&&now<s.start_ms+30*86400000&&!s.halted&&now>=s.last_ms,halted:!!s?.halted,startAt:s?new Date(s.start_ms).toISOString():null,endsAt:s?new Date(s.start_ms+30*86400000).toISOString():null,authorizationRef:s?.authorization??null,entries:db.prepare('SELECT id,root_task AS taskId,day,max_cost AS maxCostRappen,actual_cost AS actualCostRappen FROM founder_reservations ORDER BY day DESC,id LIMIT 5000').all(),entriesComplete:db.prepare('SELECT count(*) n FROM founder_reservations').get().n<=5000,spentRappen:t.spent,heldRappen:t.held,daySpentRappen:t.daily,remainingRappen:Math.max(0,15000-t.spent-t.held),dayRemainingRappen:Math.max(0,750-t.daily-t.held),scope:'Nur Aufrufe durch den Founder-Budgetadapter. Andere Prozesse sind nicht abgedeckt.'};},
  close(){db.close();}
 };
}
