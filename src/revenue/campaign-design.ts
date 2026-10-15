import {assertNoKnownSecrets} from '../observability/redaction.js';

/** Preregistered marketing design. Evidence references are requirements for
 * verification, never provider authentication or an authorization token. */
export interface CampaignDesign {
  productDigest:string;
  requirementsDigest:string;
  segment:string;
  format:string;
  callToAction:string;
  fulfillment:string;
  startsAt:number;
  endsAt:number;
  metric:'qualified_demand'|'paid_orders'|'activation'|'repeat_use'|'retention'|'net_contribution';
  attribution:{model:'experiment_id';experimentId:string;deduplicationKey:string;windowDays:number};
  claims:{statement:string;evidenceId:string;evidenceDigest:string;quote:string}[];
  channels:{name:string;segment:string;rationale:string;evidenceId:string;evidenceDigest:string;
    reachableAudience:number;conversionEstimate:number;costCeilingCents:number;risks:string;constraints:string}[];
  variants:{id:string;message:string}[];
}
const text=(v:unknown,max=1000):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const count=(v:number,max:number)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
export function assessCampaignDesign(c:CampaignDesign|undefined,plan:{audience:string;channel:string;availableTestBudgetCents:number;conservativeSales:number}){
  if(c===undefined)return {state:'MISSING' as const,executionAuthorized:false,releaseAuthorized:false,
    blockers:['Version-bound campaign design, claim evidence, attribution and channel comparison missing']};
  if(!c||!digest(c.productDigest)||!digest(c.requirementsDigest)||![c.segment,c.format,c.callToAction,c.fulfillment].every(v=>text(v))||
    !count(c.startsAt,8_640_000_000_000_000)||!count(c.endsAt,8_640_000_000_000_000)||c.endsAt<=c.startsAt||c.endsAt-c.startsAt>90*86400000||
    !['qualified_demand','paid_orders','activation','repeat_use','retention','net_contribution'].includes(c.metric)||
    !c.attribution||c.attribution.model!=='experiment_id'||!text(c.attribution.experimentId,100)||!text(c.attribution.deduplicationKey,100)||
    !count(c.attribution.windowDays,90)||c.attribution.windowDays<1||
    !Array.isArray(c.claims)||c.claims.length<1||c.claims.length>20||c.claims.some(v=>!v||![v.statement,v.quote].every(x=>text(x))||!text(v.evidenceId,100)||!digest(v.evidenceDigest))||
    !Array.isArray(c.channels)||c.channels.length<1||c.channels.length>10||new Set(c.channels.map(v=>v?.name)).size!==c.channels.length||
    c.channels.some(v=>!v||![v.name,v.segment,v.rationale,v.risks,v.constraints].every(x=>text(x))||!text(v.evidenceId,100)||!digest(v.evidenceDigest)||
      !count(v.reachableAudience,1_000_000)||!Number.isFinite(v.conversionEstimate)||v.conversionEstimate<0||v.conversionEstimate>1||!count(v.costCeilingCents,100_000_000))||
    !Array.isArray(c.variants)||c.variants.length<1||c.variants.length>10||new Set(c.variants.map(v=>v?.id)).size!==c.variants.length||
    c.variants.some(v=>!v||!text(v.id,100)||!text(v.message)))throw Error('Complete bounded campaign design with meaningful metrics required');
  assertNoKnownSecrets(c);
  const selected=c.channels.find(v=>v.name===plan.channel),blockers:string[]=[];
  if(c.segment!==plan.audience||!selected||selected.segment!==c.segment)blockers.push('Channel and customer segment mismatch');
  if(selected&&selected.costCeilingCents>plan.availableTestBudgetCents)blockers.push('Channel ceiling exceeds available planning budget');
  if(selected&&plan.conservativeSales>Math.floor(selected.reachableAudience*selected.conversionEstimate))blockers.push('Sales exceed declared reachable conversion scenario');
  if(c.attribution.windowDays*86400000>c.endsAt-c.startsAt)blockers.push('Attribution window exceeds measurement window');
  // Unchecked source references, contract hashes and textual claims cannot grant a pass.
  return {state:blockers.length?'BLOCKED' as const:'REQUIRES_EVIDENCE' as const,blockers,
    executionAuthorized:false,releaseAuthorized:false,productQualityVerified:false,claimsVerified:false,
    attributionVerified:false,selectedChannel:selected?.name??null,
    requiredVerification:['Current exact product and requirements version','Independent quality assessment',
      'Every central claim including each variant against current evidence','Channel access, legal/privacy and action gates',
      'Authentic deduplicated outcomes joined to experiment and reconciled total costs'],
    limitation:'A preregistered draft only. Reach and conversion are assumptions. Clicks, internal assessments, quotes and a stored experiment ID are not authenticated demand, revenue, attribution or profit.'};
}
