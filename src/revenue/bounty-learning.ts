import type {Database} from 'better-sqlite3';
import {actionContextDigest,assertActionGate,evaluateActionGate,securityTransaction} from '../security/action-gate.js';
import {reconciledProfitEvidence} from './profit-reconciliation.js';
import {bountyProgramUrl} from './bug-bounty.js';
export interface BountyOutcomeLink {experimentId:string;opportunityId:string;programUrl:string;statementDigest:string;triage:'accepted'|'rejected'|'duplicate'|'abandoned';elapsedMinutes:number;comparison:'baseline'|'candidate';sample:'training'|'holdout';}
export const bountyOutcomeScope=(value:BountyOutcomeLink)=>({activity:'bounty-outcome-evidence',component:'founder-security-research',dataClass:'PUBLIC' as const,contextDigest:actionContextDigest(value)});
/** Trusted reconciler boundary only. Never takes revenue, profit or permission values from an agent. */
export function linkBountyOutcome(db:Database,v:BountyOutcomeLink){
 if(!v||Object.keys(v).sort().join(',')!=='comparison,elapsedMinutes,experimentId,opportunityId,programUrl,sample,statementDigest,triage'||![v.experimentId,v.opportunityId].every(s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(s))||!/^[a-f0-9]{64}$/.test(v.statementDigest)||!Number.isFinite(v.elapsedMinutes)||v.elapsedMinutes<0||v.elapsedMinutes>100000||!['accepted','rejected','duplicate','abandoned'].includes(v.triage)||!['baseline','candidate'].includes(v.comparison)||!['training','holdout'].includes(v.sample))throw Error('Verified scoped outcome required');
 bountyProgramUrl(v.programUrl);
 return securityTransaction(db,()=>{
 assertActionGate(db,bountyOutcomeScope(v),Date.now(),['verified-bounty-triage','received-cash-and-complete-costs','preregistered-comparison']);
 const evidence=reconciledProfitEvidence(db,v.opportunityId).find(e=>e.experimentId===v.experimentId);
 if(!evidence||evidence.mode!=='live'||!evidence.reconciled||evidence.statementDigest!==v.statementDigest)throw Error('Live reconciled statement required; paper cannot train real success');
 db.exec(`CREATE TABLE IF NOT EXISTS bounty_outcomes(experiment_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS bounty_outcome_no_update BEFORE UPDATE ON bounty_outcomes BEGIN SELECT RAISE(ABORT,'Immutable outcome'); END;
 CREATE TRIGGER IF NOT EXISTS bounty_outcome_no_delete BEFORE DELETE ON bounty_outcomes BEGIN SELECT RAISE(ABORT,'Outcome retained'); END;`);
 const payload=JSON.stringify(v),digest=actionContextDigest(v),old=db.prepare('SELECT payload,digest FROM bounty_outcomes WHERE experiment_id=?').get(v.experimentId) as {payload:string;digest:string}|undefined;
 if(old){if(old.payload!==payload||old.digest!==digest)throw Error('Conflicting outcome');return;}
 if((db.prepare('SELECT COUNT(*) n FROM bounty_outcomes').get() as {n:number}).n>=1000)throw Error('Outcome review capacity reached');
 db.prepare('INSERT INTO bounty_outcomes VALUES(?,?,?)').run(v.experimentId,payload,digest);
 }).immediate();
}
/** Read-only projection. Recommendations cannot write policies or relax gates. */
export function bountyLearning(db:Database){
 const rows=db.prepare("SELECT 1 FROM sqlite_master WHERE name='bounty_outcomes'").get()?db.prepare('SELECT payload,digest FROM bounty_outcomes LIMIT 1001').all() as {payload:string;digest:string}[]:[];
 if(rows.length>1000)throw Error('Bounded learning review required');
 const usable:{programUrl:string;triage:string;elapsedMinutes:number;netCashCents:number;comparison:string;sample:string}[]=[],excluded:string[]=[],keys:string[]=[],seen=new Map<string,string>(),repeated=new Set<string>();
 for(const row of rows){const v=JSON.parse(row.payload) as BountyOutcomeLink;if(actionContextDigest(v)!==row.digest)throw Error('Outcome integrity failure');
  const gate=evaluateActionGate(db,bountyOutcomeScope(v),Date.now(),['verified-bounty-triage','received-cash-and-complete-costs','preregistered-comparison']);
  const e=reconciledProfitEvidence(db,v.opportunityId).find(e=>e.experimentId===v.experimentId);
  if(gate.state!=='APPROVED'||!e||e.mode!=='live'||!e.reconciled||e.statementDigest!==v.statementDigest){excluded.push(v.experimentId);continue;}
  const sample=JSON.stringify([e.sourceId,e.sampleUnitId]);if(seen.has(sample)){excluded.push(v.experimentId,seen.get(sample)!);repeated.add(sample);continue;}seen.set(sample,v.experimentId);keys.push(sample);
  usable.push({programUrl:v.programUrl,triage:v.triage,elapsedMinutes:v.elapsedMinutes,netCashCents:e.netProfitCents,comparison:v.comparison,sample:v.sample});
 }
 const verified=usable.filter((_row,i)=>!repeated.has(keys[i]));
 return {currency:'USD',observations:verified,excluded:[...new Set(excluded)],realSamples:verified.length,holdoutSamples:verified.filter(r=>r.sample==='holdout').length,
 totalReconciledNetCashCents:verified.reduce((n,r)=>n+r.netCashCents,0),totalMinutes:verified.reduce((n,r)=>n+r.elapsedMinutes,0),
 executionAuthorized:false,policyChanges:[],automaticPromotion:false,limitation:'Descriptive verified outcomes only; no causal or statistical improvement claim. Existing quality/security/budget and optimization-comparison gates remain required.'};
}
