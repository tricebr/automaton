import {deliveryLearningChecks, deliveryDecision, type DeliveryEvidence, type DeliverySubject} from './delivery-assurance.js';
import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {assertNoKnownSecrets} from '../observability/redaction.js';
import {PRODUCT_RELEASE_EVIDENCE} from '../commerce/quality-review.js';
import {publicationClaimsDecision,validatePublicationClaims,type PublicationClaims,type ClaimTarget} from '../commerce/claim-evidence.js';

export const GATE_DOMAINS=['security','legal','privacy','compliance','permission'] as const;
export type GateDomain=typeof GATE_DOMAINS[number];
export type GateState='APPROVED'|'BLOCKED'|'REVIEW_REQUIRED'|'INSUFFICIENT_EVIDENCE'|'STALE_EVIDENCE';
export const DATA_CLASSES=['PUBLIC','INTERNAL','PERSONAL','SENSITIVE','SECRET','CRITICAL_SECRET'] as const;
export interface ActionScope {activity:string;component:string;contextDigest:string;dataClass?:typeof DATA_CLASSES[number];claimTarget?:ClaimTarget;claimInventory?:readonly string[];deliverySubject?:DeliverySubject}
export interface GateEvidence {
  domain:GateDomain;requirement:string;jurisdiction:string;source:string;sourceDigest:string;
  observedAt:number;expiresAt:number;decision:'APPROVED'|'BLOCKED'|'REVIEW_REQUIRED';reason:string;
}
export interface ReviewedAction extends ActionScope {
  reviewedBy:string;classification:typeof DATA_CLASSES[number];evidence:GateEvidence[];
  publicationClaims?:PublicationClaims;
  deliveryEvidence?:DeliveryEvidence;
  privacy?:{purpose:string;minimumFields:string[];retentionDays:number;processors:{id:string;country:string;purpose:string}[]};
}
const id=(s:unknown):s is string=>typeof s==='string'&&/^[a-zA-Z0-9_:./-]{1,180}$/.test(s);
const hash=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export const actionContextDigest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeKey=(scope:ActionScope)=>actionContextDigest([scope.activity,scope.component,scope.contextDigest,scope.dataClass??'PUBLIC',...(scope.claimTarget?[scope.claimTarget]:[]),...(scope.claimInventory?[scope.claimInventory]:[]),...(scope.deliverySubject?[scope.deliverySubject]:[])]);
function validateScope(scope:ActionScope){
  if(!scope||!id(scope.activity)||!id(scope.component)||!hash(scope.contextDigest)||scope.dataClass!==undefined&&!DATA_CLASSES.includes(scope.dataClass))throw Error('Invalid action scope');
  if(scope.claimTarget&&scope.claimTarget.payloadDigest!==scope.contextDigest)throw Error('Claim payload must match action context');
  if(scope.claimInventory&&(!Array.isArray(scope.claimInventory)||!scope.claimInventory.length||scope.claimInventory.length>100||!Array.from(scope.claimInventory).every(hash)))throw Error('Invalid claim inventory binding');
}
function schema(db:Database){
 db.exec(`CREATE TABLE IF NOT EXISTS obolus_action_reviews(id TEXT PRIMARY KEY,scope_hash TEXT NOT NULL,reviewed_ms INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS action_reviews_scope ON obolus_action_reviews(scope_hash,reviewed_ms);
 CREATE TABLE IF NOT EXISTS obolus_action_revocations(id TEXT PRIMARY KEY,created_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS obolus_security_halt(id INTEGER PRIMARY KEY CHECK(id=1));
 CREATE TABLE IF NOT EXISTS obolus_security_audit(id INTEGER PRIMARY KEY,scope_hash TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,created_ms INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS action_reviews_update BEFORE UPDATE ON obolus_action_reviews BEGIN SELECT RAISE(ABORT,'Action evidence immutable'); END;
 CREATE TRIGGER IF NOT EXISTS action_reviews_delete BEFORE DELETE ON obolus_action_reviews BEGIN SELECT RAISE(ABORT,'Action evidence immutable'); END;
 CREATE TRIGGER IF NOT EXISTS action_revocations_delete BEFORE DELETE ON obolus_action_revocations BEGIN SELECT RAISE(ABORT,'Revocation irreversible'); END;
 CREATE TRIGGER IF NOT EXISTS action_revocations_update BEFORE UPDATE ON obolus_action_revocations BEGIN SELECT RAISE(ABORT,'Revocation irreversible'); END;
 CREATE TRIGGER IF NOT EXISTS security_audit_update BEFORE UPDATE ON obolus_security_audit BEGIN SELECT RAISE(ABORT,'Security audit immutable'); END;
 CREATE TRIGGER IF NOT EXISTS security_audit_delete BEFORE DELETE ON obolus_security_audit BEGIN SELECT RAISE(ABORT,'Security audit immutable'); END;
 CREATE TRIGGER IF NOT EXISTS security_halt_delete BEFORE DELETE ON obolus_security_halt BEGIN SELECT RAISE(ABORT,'Security incident requires trusted recovery'); END;`);
}
function validateReview(review:ReviewedAction,now:number){
 if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid review clock');
 validateScope(review);assertNoKnownSecrets(review);
 if(review.publicationClaims!==undefined)validatePublicationClaims(review.publicationClaims);
 if(!id(review.reviewedBy)||!DATA_CLASSES.includes(review.classification)||!Array.isArray(review.evidence)||review.evidence.length<5||review.evidence.length>50)
  throw Error('Complete reviewed action evidence required');
 if(review.classification!==(review.dataClass??'PUBLIC'))throw Error('Classification mismatch; downgrade forbidden');
 if(['SECRET','CRITICAL_SECRET'].includes(review.classification))throw Error('Secret material cannot receive ordinary action export approval');
 if(['PERSONAL','SENSITIVE'].includes(review.classification)){
  const p=review.privacy;
  if(!p||!id(p.purpose)||!Array.isArray(p.minimumFields)||!p.minimumFields.length||p.minimumFields.length>30||!Array.from(p.minimumFields).every(id)||
   !Number.isSafeInteger(p.retentionDays)||p.retentionDays<1||p.retentionDays>365||!Array.isArray(p.processors)||!p.processors.length||p.processors.length>10||
   Array.from(p.processors).some(item=>!item||!id(item.id)||!id(item.country)||!id(item.purpose)))throw Error('Personal data requires bounded purpose, minimization, retention and processor inventory');
  if(new Set(p.minimumFields).size!==p.minimumFields.length||new Set(p.processors.map(item=>item.id)).size!==p.processors.length)
   throw Error('Ambiguous privacy inventory: duplicate fields or processors');
 }
 for(const e of review.evidence){
  if(!e||!GATE_DOMAINS.includes(e.domain)||!id(e.requirement)||!id(e.jurisdiction)||!hash(e.sourceDigest)||
   !['APPROVED','BLOCKED','REVIEW_REQUIRED'].includes(e.decision)||typeof e.reason!=='string'||!e.reason.trim()||e.reason.length>1000||
   typeof e.source!=='string'||e.source.length>2000||!/^https:\/\//.test(e.source)||
   !Number.isSafeInteger(e.observedAt)||e.observedAt<0||e.observedAt>now||!Number.isSafeInteger(e.expiresAt)||
   e.expiresAt<=e.observedAt||e.expiresAt-e.observedAt>7*86400000)throw Error('Invalid evidence, jurisdiction, source or validity window');
  const url=new URL(e.source);if(url.username||url.password||url.hash||url.search)throw Error('Evidence URL must not contain credentials or query data');
 }
 if(GATE_DOMAINS.some(domain=>!review.evidence.some(e=>e.domain===domain)))throw Error('Missing gate domain');
}
/** Trusted operator/control-plane API, intentionally NOT an agent tool. Source
 * references/digests are evidence bindings, not proof of a law or source's truth.
 * The trusted reviewer must verify them; ordinary model assertions cannot grant. */
export function registerActionReview(db:Database,review:ReviewedAction,now=Date.now()){
 validateReview(review,now);
 const payload=JSON.stringify(review),digest=actionContextDigest(review),key=scopeKey(review);
 db.transaction(()=>{schema(db);
  const old=db.prepare('SELECT digest,reviewed_ms FROM obolus_action_reviews WHERE scope_hash=? ORDER BY reviewed_ms DESC LIMIT 1').get(key) as {digest:string;reviewed_ms:number}|undefined;
  if(old&&old.digest===digest)return;
  if(old&&now<=old.reviewed_ms)throw Error('Revalidation must be newer than the previous review');
  db.prepare('INSERT INTO obolus_action_reviews VALUES(?,?,?,?,?)').run(digest,key,now,payload,digest);
 }).immediate();
}
export function revokeActionReview(db:Database,scope:ActionScope){
 validateScope(scope);schema(db);
 const current=db.prepare('SELECT id FROM obolus_action_reviews WHERE scope_hash=? ORDER BY reviewed_ms DESC LIMIT 1').get(scopeKey(scope)) as {id:string}|undefined;
 if(!current)throw Error('No existing review to revoke');
 db.prepare('INSERT OR IGNORE INTO obolus_action_revocations VALUES(?,?)').run(current.id,Date.now());
}
export function containSecurityIncident(db:Database){schema(db);db.prepare('INSERT OR IGNORE INTO obolus_security_halt VALUES(1)').run();}
export function evaluateActionGate(db:Database,scope:ActionScope,now=Date.now(),requiredEvidence:readonly string[]=[]):{state:GateState;reason:string}{
 validateScope(scope);
 if(!Array.isArray(requiredEvidence)||requiredEvidence.length>45||!Array.from(requiredEvidence).every(id))throw Error('Invalid required evidence profile');
 const publication=['code-delivery','live-checkout','product-publication','support-publication','external-publication'].includes(scope.activity);
 const requirements=publication?[...PRODUCT_RELEASE_EVIDENCE,...requiredEvidence]:requiredEvidence;
 const result=(state:GateState,reason:string)=>({state,reason});
 if(!Number.isSafeInteger(now)||now<0)return result('BLOCKED','INVALID_CLOCK');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_action_reviews'").get())return result('INSUFFICIENT_EVIDENCE','REVIEW_ABSENT');
 try{
  if(db.prepare('SELECT 1 FROM obolus_security_halt').get())return result('BLOCKED','SECURITY_INCIDENT');
  const key=scopeKey(scope);
  const row=db.prepare('SELECT id,payload,digest,reviewed_ms FROM obolus_action_reviews WHERE scope_hash=? ORDER BY reviewed_ms DESC LIMIT 1').get(key) as {id:string;payload:string;digest:string;reviewed_ms:number}|undefined;
  if(!row)return result('INSUFFICIENT_EVIDENCE','REVIEW_ABSENT');
  if(!Number.isSafeInteger(row.reviewed_ms)||row.reviewed_ms>now||row.reviewed_ms<0)return result('BLOCKED','REVIEW_CLOCK_INVALID');
  if(db.prepare('SELECT 1 FROM obolus_action_revocations WHERE id=?').get(row.id))return result('BLOCKED','REVIEW_REVOKED');
  const review=JSON.parse(row.payload) as ReviewedAction;
  if(actionContextDigest(review)!==row.digest||scopeKey(review)!==key)return result('BLOCKED','EVIDENCE_INTEGRITY');
  validateReview(review,now);
  if(review.evidence.some(e=>e.decision==='BLOCKED'))return result('BLOCKED','EVIDENCE_DENIAL');
  if(review.evidence.some(e=>e.decision==='REVIEW_REQUIRED'))return result('REVIEW_REQUIRED','MATERIAL_AMBIGUITY');
  if(review.evidence.some(e=>e.expiresAt<=now))return result('STALE_EVIDENCE','REVALIDATION_REQUIRED');
  if(requirements.some(requirement=>!review.evidence.some(e=>e.requirement===requirement&&e.decision==='APPROVED')))
   return result('INSUFFICIENT_EVIDENCE','REQUIRED_EVIDENCE_ABSENT');
  if(publication){
   const target=scope.claimTarget??(['support-publication','external-publication'].includes(scope.activity)&&review.publicationClaims?.target.payloadDigest===scope.contextDigest?review.publicationClaims.target:undefined);
   const failure=publicationClaimsDecision(review.publicationClaims,target,now);
   if(failure)return result(failure==='CLAIM_REVALIDATION_REQUIRED'?'STALE_EVIDENCE':'INSUFFICIENT_EVIDENCE',failure);
   if(scope.claimInventory?.some(digest=>!review.publicationClaims!.claims.some(c=>actionContextDigest(c.statement)===digest)))return result('INSUFFICIENT_EVIDENCE','CLAIM_INVENTORY_INCOMPLETE');
  }
  if(scope.activity==='code-delivery'||scope.deliverySubject||review.deliveryEvidence){
   const failure=deliveryDecision(review.deliveryEvidence,scope.deliverySubject,now);
   if(failure)return result(failure==='DELIVERY_STALE'?'STALE_EVIDENCE':'INSUFFICIENT_EVIDENCE',failure);
   if(review.deliveryEvidence!.reviewer!==review.reviewedBy)return result('BLOCKED','DELIVERY_REVIEWER_MISMATCH');
  }
  return result('APPROVED','CURRENT_SCOPED_REVIEW');
 }catch{return result('BLOCKED','EVIDENCE_UNVERIFIABLE');}
}
/** Call inside admission transaction, before reservation and external I/O. */
class ActionGateError extends Error {
 constructor(readonly scope:ActionScope,readonly state:GateState,readonly reason:string,readonly at:number){
  super(`Action gate ${state}: ${reason}`);
 }
}
/** Keep the denial record after admission rolls back. Nested admissions defer
 * persistence to their outer boundary; never commit a failed reservation. */
export function securityTransaction<T>(db:Database,work:()=>T){
 return {immediate:():T=>{
  try{return db.transaction(work).immediate();}
  catch(error){
   if(error instanceof ActionGateError&&!db.inTransaction){
    schema(db);
    db.prepare('INSERT INTO obolus_security_audit(scope_hash,state,reason,created_ms) VALUES(?,?,?,?)')
     .run(scopeKey(error.scope),error.state,error.reason,error.at);
   }
   throw error;
  }
 }};
}
export function assertActionGate(db:Database,scope:ActionScope,now=Date.now(),requiredEvidence:readonly string[]=[]){
 const decision=evaluateActionGate(db,scope,now,requiredEvidence);schema(db);
 db.prepare('INSERT INTO obolus_security_audit(scope_hash,state,reason,created_ms) VALUES(?,?,?,?)').run(scopeKey(scope),decision.state,decision.reason,now);
 if(decision.state!=='APPROVED')throw new ActionGateError({...scope},decision.state,decision.reason,now);
}
/** Bounded, side-effect-free alternative evaluation; a different objective label
 * or a higher profit score never modifies the original scope or approval. */
export function selectSafeAlternative(db:Database,blocked:ActionScope,candidates:ActionScope[],now=Date.now()){
 validateScope(blocked);
 if(!Array.isArray(candidates)||candidates.length>16)throw Error('Bounded alternative set required');
 return candidates.find(candidate=>{validateScope(candidate);return scopeKey(candidate)!==scopeKey(blocked)&&
  evaluateActionGate(db,candidate,now).state==='APPROVED';})??null;
}

/** Read-only lessons from current trusted reviews; never return stored free text to agents. */
export function deliveryReviewLessons(db:Database,now=Date.now()):string[]{
 try {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_action_reviews'").get())return [];
  const rows=db.prepare('SELECT payload FROM obolus_action_reviews ORDER BY reviewed_ms DESC LIMIT 20').all() as {payload:string}[];
  const checks=new Set<string>();
  for(const row of rows){
   if(row.payload.length>500000)continue;
   const review=JSON.parse(row.payload) as ReviewedAction;
   if(!review.deliveryEvidence||evaluateActionGate(db,review,now).state!=='APPROVED')continue;
   for(const check of deliveryLearningChecks(review.deliveryEvidence.defects.map(d=>d.category)))checks.add(check);
  }
  return [...checks].sort().map(check=>`Verified delivery defect history requires ${check} regression evidence on the new exact source and artifact. Prior approval does not transfer; no publication or payment is implied.`);
 }catch{return ['Delivery learning evidence unavailable: retain every required check and obtain a new trusted review.'];}
}
