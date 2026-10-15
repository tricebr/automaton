import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {reviewState} from './trade-review.mjs';

// Local evidence journal only: no broker, notification transport or credentials.
export function openTradeJournal(file){
 const db=new Database(file);db.pragma('journal_mode = WAL');db.pragma('busy_timeout = 5000');
 db.exec('CREATE TABLE IF NOT EXISTS trade_events(id TEXT PRIMARY KEY, kind TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL)');
 const append=db.transaction((id,kind,payload)=>{
  if(!/^[a-zA-Z0-9:._-]{1,180}$/.test(id)||!['proposal','observation','decision'].includes(kind))throw Error('Invalid event identity');
  const body=JSON.stringify(payload);if(body.length>24000)throw Error('Event too large');
  const old=db.prepare('SELECT kind,payload FROM trade_events WHERE id=?').get(id);
  if(old){if(old.kind!==kind||old.payload!==body)throw Error('Conflicting event');return false;}
  db.prepare('INSERT INTO trade_events VALUES(?,?,?,?)').run(id,kind,Date.now(),body);return true;
 });
 return {
  recordProposal(id,p){if(!reviewState(p).canAcknowledge)throw Error('Proposal incomplete or stale');return append.immediate(id,'proposal',p);},
  observe(data){
   const age=Date.now()-Date.parse(data?.observedAt);
   if(!Number.isFinite(age)||age< -1000||age>15000||!Array.isArray(data.positions)||!Array.isArray(data.pendingOrders))throw Error('Fresh broker snapshot required');
   const payload={observedAt:data.observedAt,positions:data.positions,pendingOrders:data.pendingOrders};
   return append.immediate('mt5:'+createHash('sha256').update(JSON.stringify(payload)).digest('hex'),'observation',payload);
  },
  decide(id,proposalId,decision){
   if(!['reviewed','declined'].includes(decision))throw Error('Invalid decision');
   const row=db.prepare("SELECT payload FROM trade_events WHERE id=? AND kind='proposal'").get(proposalId);
   if(!row||!reviewState(JSON.parse(row.payload)).canAcknowledge)throw Error('Proposal absent or expired');
   return append.immediate(id,'decision',{proposalId,decision,executionEnabled:false});
  },
  snapshot(){
   const row=db.prepare("SELECT id,payload FROM trade_events WHERE kind='proposal' ORDER BY recorded_at DESC,rowid DESC LIMIT 1").get();
   const proposal=row?{...JSON.parse(row.payload),id:row.id}:null;
   return {proposal,gate:reviewState(proposal),history:db.prepare('SELECT id,kind,recorded_at FROM trade_events ORDER BY recorded_at DESC,rowid DESC LIMIT 30').all(),persistent:true,executionEnabled:false};
  },
  close(){db.close();},
 };
}
