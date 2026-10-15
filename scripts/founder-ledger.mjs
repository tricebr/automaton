import Database from 'better-sqlite3';
import {randomUUID,createHash} from 'node:crypto';
import {periodRange,businessDay} from '../web/founder/model.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function openFounderLedger(file){
 const db=new Database(file);db.pragma('journal_mode = WAL');
 db.exec(`CREATE TABLE IF NOT EXISTS finance_entries(id TEXT PRIMARY KEY,day TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,title TEXT NOT NULL,evidence TEXT NOT NULL UNIQUE); CREATE TABLE IF NOT EXISTS finance_closures(period TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,evidence TEXT NOT NULL,at TEXT NOT NULL);`);
 function snapshot(report,budget,now=Date.now()){
  const entries=db.prepare('SELECT * FROM finance_entries ORDER BY day,id').all();
  const closures={};for(const period of ['today','week','month','year']){
   const range=periodRange(period,now),inside=day=>day>=range.from&&day<=range.to;
   const fingerprint=hash([range,entries.filter(e=>inside(e.day)),(report?.transactions??[]).filter(t=>inside(businessDay(t.created*1000))).sort((a,b)=>a.id.localeCompare(b.id)),(budget?.entries??[]).filter(e=>inside(e.day)).sort((a,b)=>a.id.localeCompare(b.id)),budget?.entriesComplete]);
   const saved=db.prepare('SELECT * FROM finance_closures WHERE period=?').get(period);
   closures[period]={fingerprint,complete:saved?.fingerprint===fingerprint,at:saved?.at??null,evidence:saved?.evidence??null};
  }return {entries,closures};
 }
 return {snapshot,apply(input,report,budget,now=Date.now()){
  if(input?.action==='add'){
   const {day,kind,amount,title,evidence}=input;
   if(!/^\d{4}-\d{2}-\d{2}$/.test(day??'')||!Number.isFinite(Date.parse(day+'T12:00:00Z'))||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day||day>businessDay(now)||!['income','expense','refund','expense-refund','transfer'].includes(kind)||!Number.isSafeInteger(amount)||amount<=0||amount>100000000||typeof title!=='string'||!title.trim()||title.length>160||typeof evidence!=='string'||evidence.trim().length<5||evidence.length>400||evidence.startsWith('txn_'))throw Error('Ungültiger Beleg');
   db.prepare('INSERT INTO finance_entries VALUES(?,?,?,?,?,?)').run(randomUUID(),day,kind,amount,title.trim(),evidence.trim());
  }else if(input?.action==='close'){
   const {period,fingerprint,evidence}=input;const state=snapshot(report,budget,now).closures[period];
   if(!state||fingerprint!==state.fingerprint||typeof evidence!=='string'||evidence.trim().length<10||evidence.length>400)throw Error('Abgleich veraltet oder Nachweis fehlt');
   db.prepare('INSERT OR REPLACE INTO finance_closures VALUES(?,?,?,?)').run(period,fingerprint,evidence.trim(),new Date(now).toISOString());
  }else throw Error('Ungültige Aktion');return snapshot(report,budget,now);
 },close:()=>db.close()};
}
