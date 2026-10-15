import type {Database} from 'better-sqlite3';
import {haltInferenceBudget} from './budget-policy.js';

const cents=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=100_000_000;
const time=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=8_640_000_000_000_000;
function exists(db:Database){
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('inference_phase_budget','inference_phase_charges')").all() as {name:string}[];
 if(names.length===1)throw Error('Incomplete inference phase accounting');
 return names.length===2;
}
/** Explicit, trusted setup on a fresh research DB only. USD cents match existing
 * inference accounting; this is not CHF conversion or Founder authorization.
 * No code calls this against the active config or operating database. */
export function initializeInferencePhase(db:Database,input:{startsAt:number;endsAt:number;limitCents:number}){
 if(!input||!time(input.startsAt)||!time(input.endsAt)||input.endsAt<=input.startsAt||
  input.endsAt-input.startsAt>14*86400000||!cents(input.limitCents))throw Error('Bounded inference phase required');
 db.transaction(()=>{
  if(exists(db))throw Error('Inference phase already initialized');
  if(db.prepare('SELECT 1 FROM inference_reservations LIMIT 1').get()||db.prepare('SELECT 1 FROM inference_costs LIMIT 1').get())throw Error('Fresh inference database required');
  db.exec(`CREATE TABLE inference_phase_budget(id INTEGER PRIMARY KEY CHECK(id=1),starts_ms INTEGER NOT NULL,ends_ms INTEGER NOT NULL,limit_cents INTEGER NOT NULL,last_ms INTEGER NOT NULL,halted INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE inference_phase_charges(reservation_id TEXT PRIMARY KEY REFERENCES inference_reservations(id),reserved_cents INTEGER NOT NULL,actual_cents INTEGER);
   CREATE TRIGGER phase_policy_immutable BEFORE UPDATE OF starts_ms,ends_ms,limit_cents ON inference_phase_budget BEGIN SELECT RAISE(ABORT,'Immutable phase budget'); END;
   CREATE TRIGGER phase_no_resume BEFORE UPDATE OF halted ON inference_phase_budget WHEN OLD.halted=1 AND NEW.halted<>1 BEGIN SELECT RAISE(ABORT,'Phase halt retained'); END;
   CREATE TRIGGER phase_no_delete BEFORE DELETE ON inference_phase_budget BEGIN SELECT RAISE(ABORT,'Phase policy retained'); END;
   CREATE TRIGGER phase_charge_no_delete BEFORE DELETE ON inference_phase_charges BEGIN SELECT RAISE(ABORT,'Phase charge retained'); END;
   CREATE TRIGGER phase_charge_immutable BEFORE UPDATE ON inference_phase_charges WHEN OLD.actual_cents IS NOT NULL OR NEW.reservation_id<>OLD.reservation_id OR NEW.reserved_cents<>OLD.reserved_cents BEGIN SELECT RAISE(ABORT,'Phase settlement immutable'); END;`);
  db.prepare('INSERT INTO inference_phase_budget VALUES(1,?,?,?,?,0)').run(input.startsAt,input.endsAt,input.limitCents,input.startsAt);
  db.prepare("INSERT INTO inference_budget_audit(action,detail) VALUES('phase_initialize',?)").run(JSON.stringify(input));
 }).immediate();
}
export function inferencePhaseSnapshot(db:Database){
 if(!exists(db))return null;
 const p=db.prepare('SELECT * FROM inference_phase_budget WHERE id=1').get() as {starts_ms:number;ends_ms:number;limit_cents:number;last_ms:number;halted:number}|undefined;
 if(!p||!time(p.starts_ms)||!time(p.ends_ms)||p.ends_ms<=p.starts_ms||p.ends_ms-p.starts_ms>14*86400000||!time(p.last_ms)||p.last_ms<p.starts_ms||!cents(p.limit_cents)||![0,1].includes(p.halted))throw Error('Invalid inference phase policy');
 const rows=db.prepare(`SELECT r.reserved_cents,r.status,c.reserved_cents AS bound_cents,c.reservation_id,c.actual_cents FROM inference_reservations r LEFT JOIN inference_phase_charges c ON c.reservation_id=r.id`).all() as {reserved_cents:number;bound_cents:number;status:string;reservation_id:string|null;actual_cents:number|null}[];
 if((db.prepare('SELECT COUNT(*) n FROM inference_phase_charges').get() as {n:number}).n!==rows.length)throw Error('Inference phase ledger mismatch');
 let spentCents=0,pendingCents=0;
 for(const r of rows){
  if(!r.reservation_id||!cents(r.reserved_cents)||r.bound_cents!==r.reserved_cents||!['pending','settled'].includes(r.status)||
   (r.status==='pending'?r.actual_cents!==null:!cents(r.actual_cents)))throw Error('Invalid inference phase accounting');
  if(r.status==='pending')pendingCents+=r.reserved_cents;else spentCents+=r.actual_cents!;
 }
 if(!Number.isSafeInteger(spentCents+pendingCents))throw Error('Inference phase aggregate overflow');
 return {...p,spentCents,pendingCents};
}
/** Persist observed expiry before any later admission rollback. Only router entry
 * calls this independently; no automatic resume or clock reset is supported. */
export function observeInferencePhase(db:Database,now=Date.now()){
 if(!exists(db))return;
 db.transaction(()=>{
  const p=inferencePhaseSnapshot(db)!;
  if(!time(now)||now<p.last_ms)throw Error('Inference phase clock rollback');
  db.prepare('UPDATE inference_phase_budget SET last_ms=?,halted=? WHERE id=1').run(now,now>=p.ends_ms?1:p.halted);
 }).immediate();
}
/** Called inside the router's existing immediate reservation transaction. */
export function admitInferencePhase(db:Database,estimatedCents:number,now=Date.now(),required=false){
 if(!db.inTransaction)throw Error('Phase admission requires transaction');
 const p=inferencePhaseSnapshot(db);if(!p){if(required)throw Error('Required inference phase missing');return;}
 if(!time(now)||now<p.last_ms||now<p.starts_ms||now>=p.ends_ms||p.halted)throw Error('Inference phase inactive, halted or clock rollback');
 if(!cents(estimatedCents)||p.spentCents+p.pendingCents+estimatedCents>p.limit_cents)throw Error('Inference phase total budget exceeded');
 db.prepare('UPDATE inference_phase_budget SET last_ms=? WHERE id=1').run(now);
}
export function bindInferencePhase(db:Database,id:string){
 if(!db.inTransaction)throw Error('Phase binding requires transaction');
 if(exists(db)){
  if(db.prepare('INSERT INTO inference_phase_charges(reservation_id,reserved_cents,actual_cents) SELECT id,reserved_cents,NULL FROM inference_reservations WHERE id=? AND status=\'pending\'').run(id).changes!==1)throw Error('Pending phase reservation required');
 }
}
/** Settlement survives pruning of the ordinary cost history. Unknown cost holds
 * cannot be released through the legacy callback-only API on a phase DB. */
export function settleInferencePhase(db:Database,id:string,actualCents?:number){
 if(!db.inTransaction)throw Error('Phase settlement requires transaction');
 if(!exists(db))return;
 if(!cents(actualCents))throw Error('Explicit actual phase cost required');
 const r=db.prepare('SELECT reserved_cents FROM inference_reservations WHERE id=? AND status=\'settled\'').get(id) as {reserved_cents:number}|undefined;
 if(!r||!cents(r.reserved_cents)||db.prepare('UPDATE inference_phase_charges SET actual_cents=? WHERE reservation_id=? AND actual_cents IS NULL').run(actualCents,id).changes!==1)throw Error('Unsettled phase hold required');
 const p=inferencePhaseSnapshot(db)!;
 if(actualCents>r.reserved_cents||p.spentCents+p.pendingCents>p.limit_cents){
  db.prepare('UPDATE inference_phase_budget SET halted=1 WHERE id=1').run();
  haltInferenceBudget(db,'Inference phase price contract exceeded');
 }
 db.prepare("INSERT INTO inference_budget_audit(action,detail) VALUES('phase_settle',?)").run(JSON.stringify({reservationId:id,actualCents}));
}
