import type {Database} from 'better-sqlite3';
import {actionContextDigest} from '../security/action-gate.js';
import {assertModelPrivacy} from '../security/privacy-egress.js';
import {assertNoPersonnelCostInputs} from './personnel-cost-policy.js';
import {bountyProgramUrl} from './bug-bounty.js';
/** Private draft only. It cannot grant scope, send a report or manufacture proof. */
export interface BountyDraft {
 id:string;programUrl:string;policyDigest:string;observedAt:number;expiresAt:number;
 inScope:string[];outOfScope:string[];methods:string[];excludedMethods:string[];
 automation:'allowed'|'forbidden'|'unknown';aiUse:'allowed'|'forbidden'|'unknown';humanReview:'required'|'not-required'|'unknown';submission:'manual'|'automatic'|'unknown';
 rateLimit:number|null;eligibility:'verified'|'unknown';ownership:'verified'|'unknown';dataRules:'reviewed'|'unknown';disclosureRules:'reviewed'|'unknown';
 target:string;method:'response-header-review';title:string;reproduction:string[];impact:string|null;duplicateStatus:'unknown'|'duplicate'|'checked';
 provenance:'synthetic'|'unverified';currency:'CHF'|'USD'|'EUR';elapsedMinutes:number;cashCostCents:number|null;
}
export function buildBountyShadowDraft(db:Database,input:BountyDraft,now=Date.now()){
 assertNoPersonnelCostInputs(input);assertModelPrivacy(input);
 const keys='aiUse,automation,cashCostCents,currency,dataRules,disclosureRules,duplicateStatus,elapsedMinutes,eligibility,excludedMethods,expiresAt,humanReview,id,impact,inScope,method,methods,observedAt,outOfScope,ownership,policyDigest,programUrl,provenance,rateLimit,reproduction,submission,target,title';
 if(!input||Object.keys(input).sort().join(',')!==keys||!/^bounty_[a-z0-9_-]{1,60}$/.test(input.id)||!Number.isSafeInteger(now)||!/^[a-f0-9]{64}$/.test(input.policyDigest))throw Error('Strict shadow draft required');
 bountyProgramUrl(input.programUrl);
 for(const values of [input.inScope,input.outOfScope,input.methods,input.excludedMethods,input.reproduction])if(!Array.isArray(values)||values.length>30||values.some(v=>typeof v!=='string'||!v.trim()||v.length>2000))throw Error('Bounded report fields required');
 if(![input.observedAt,input.expiresAt].every(n=>Number.isSafeInteger(n)&&n>=0)||input.observedAt>now||input.expiresAt<=input.observedAt||input.expiresAt-input.observedAt>7*86400000||!Number.isFinite(input.elapsedMinutes)||input.elapsedMinutes<0||input.elapsedMinutes>20160||input.cashCostCents!==null&&(!Number.isSafeInteger(input.cashCostCents)||input.cashCostCents<0||input.cashCostCents>100000000)||input.rateLimit!==null&&(!Number.isSafeInteger(input.rateLimit)||input.rateLimit<0||input.rateLimit>1000))throw Error('Invalid times or bounded measures');
 for(const [v,allowed] of [[input.automation,['allowed','forbidden','unknown']],[input.aiUse,['allowed','forbidden','unknown']],[input.humanReview,['required','not-required','unknown']],[input.submission,['manual','automatic','unknown']],[input.eligibility,['verified','unknown']],[input.ownership,['verified','unknown']],[input.dataRules,['reviewed','unknown']],[input.disclosureRules,['reviewed','unknown']],[input.duplicateStatus,['unknown','duplicate','checked']],[input.provenance,['synthetic','unverified']]] as [string,string[]][])if(!allowed.includes(v))throw Error('Unknown report enum');
 if(!['CHF','USD','EUR'].includes(input.currency)||input.method!=='response-header-review'||typeof input.target!=='string'||input.target.length>2000||typeof input.title!=='string'||!input.title.trim()||input.title.length>200||input.impact!==null&&(typeof input.impact!=='string'||input.impact.length>2000))throw Error('Unsupported report');
 const blockers=['shadow_only','independent_impact_proof_missing','trusted_program_authorization_missing'];
 const url=new URL(input.target);if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)throw Error('Minimized HTTPS target reference required');
 if(now>=input.expiresAt)blockers.push('stale_rules');
 if(!input.inScope.includes(input.target)||input.outOfScope.includes(input.target))blockers.push('target_not_explicitly_in_scope');
 if(!input.methods.includes(input.method)||input.excludedMethods.includes(input.method))blockers.push('method_not_explicitly_allowed');
 if(input.automation!=='allowed'||input.aiUse!=='allowed')blockers.push('automation_or_ai_not_allowed');
 if(input.humanReview!=='not-required')blockers.push('human_review_required_or_unknown');
 if(input.submission!=='automatic')blockers.push('automatic_submission_not_allowed');
 if(input.eligibility!=='verified'||input.ownership!=='verified'||input.dataRules!=='reviewed'||input.disclosureRules!=='reviewed'||input.rateLimit===null)blockers.push('rules_incomplete');
 if(input.duplicateStatus!=='checked')blockers.push('duplicate_check_incomplete_or_duplicate');
 if(!input.reproduction.length||!input.impact)blockers.push('report_incomplete');
 if(input.cashCostCents===null)blockers.push('cash_cost_unknown');
 const result={report:{programUrl:input.programUrl,target:input.target,method:input.method,reproduction:input.reproduction,claimedImpact:input.impact,policyDigest:input.policyDigest,ruleObservedAt:input.observedAt,ruleExpiresAt:input.expiresAt},draftId:input.id,title:input.title,provenance:input.provenance,blockers,elapsedMinutes:input.elapsedMinutes,reportedCashCostCents:input.cashCostCents,
 currency:input.currency,confirmedVulnerability:false,submissionReady:false,submissionAuthorized:false,realLearningEligible:false,realizedRevenueCents:0,realizedProfitCents:null,inputDigest:actionContextDigest(input)};
 return db.transaction(()=>{db.exec(`CREATE TABLE IF NOT EXISTS bounty_shadow_drafts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS bounty_draft_no_update BEFORE UPDATE ON bounty_shadow_drafts BEGIN SELECT RAISE(ABORT,'Immutable draft version'); END;
 CREATE TRIGGER IF NOT EXISTS bounty_draft_no_delete BEFORE DELETE ON bounty_shadow_drafts BEGIN SELECT RAISE(ABORT,'Draft retained'); END;`);
 const payload=JSON.stringify(result),digest=actionContextDigest(result),old=db.prepare('SELECT payload,digest FROM bounty_shadow_drafts WHERE id=?').get(input.id) as {payload:string;digest:string}|undefined;
 if(old){if(old.payload!==payload||old.digest!==digest)throw Error('Conflicting draft version or integrity');return result;}
 if((db.prepare('SELECT COUNT(*) n FROM bounty_shadow_drafts').get() as {n:number}).n>=200)throw Error('Draft capacity reached');
 db.prepare('INSERT INTO bounty_shadow_drafts VALUES(?,?,?)').run(input.id,payload,digest);db.prepare("INSERT INTO online_audit(action,detail) VALUES('bounty_shadow_draft',?)").run(JSON.stringify({id:input.id,digest}));return result;}).immediate();
}
