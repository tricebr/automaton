import type {Database} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {assertNoKnownSecrets} from '../observability/redaction.js';

export const CUSTOMER_FIELDS = ['segment','job','frequency','urgency','impact','workaround','differentiation','willingnessToPay','channel'] as const;
export const MARKET_FIELDS = ['reachableMarket','purchaseFrequency','purchaseIntent','marketSaturation','entryBarriers','competitorQuality','competitorAudience','competitorChannel','customerExperience','alternativeWeakness','measurableBenefit','noActionAlternative'] as const;
export interface CustomerClaim {
  field: typeof CUSTOMER_FIELDS[number] | typeof MARKET_FIELDS[number];
  statement: string;
  method: string;
  confidence: number;
  /** Declared collection method, not authentication of a customer or payment. */
  observationKind?: 'measurement'|'interview'|'interest'|'signup'|'order'|'payment_claim'|'public_indicator'|'model_estimate';
  citations: {evidenceId:string;evidenceDigest:string;quote:string;direction:'supports'|'contradicts'}[];
}
export interface CustomerAnalysis {
  version: 1;
  claims: CustomerClaim[];
  /** Optional extension; absent fields remain unknown, never inferred from competitor counts. */
  marketClaims?: CustomerClaim[];
  alternatives: {name:string;kind:'direct'|'indirect'|'workaround';currency:'CHF'|'USD'|'EUR';
    priceCents:number;periodDays:number;units:number;scope:string;evidenceId:string;evidenceDigest:string}[];
}
const bounded=(v:unknown,max=1000):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validateCustomerAnalysis(value:CustomerAnalysis){
  if(!value||value.version!==1||!Array.isArray(value.claims)||value.claims.length>9||
    new Set(value.claims.map(c=>c?.field)).size!==value.claims.length||!Array.isArray(value.alternatives)||value.alternatives.length>12)
    throw Error('Bounded versioned customer analysis required');
  if(value.marketClaims!==undefined&&(!Array.isArray(value.marketClaims)||value.marketClaims.length>MARKET_FIELDS.length||new Set(value.marketClaims.map(c=>c?.field)).size!==value.marketClaims.length))throw Error('Invalid market claims');
  for(const c of [...value.claims,...(value.marketClaims??[])]){
    if(!c||!(value.claims.includes(c)?(CUSTOMER_FIELDS as readonly string[]):(MARKET_FIELDS as readonly string[])).includes(c.field)||!bounded(c.statement)||!bounded(c.method,200)||
      c.observationKind!==undefined&&!['measurement','interview','interest','signup','order','payment_claim','public_indicator','model_estimate'].includes(c.observationKind)||
      !Number.isFinite(c.confidence)||c.confidence<0||c.confidence>1||!Array.isArray(c.citations)||c.citations.length>12||
      c.citations.some(x=>!x||!bounded(x.evidenceId,100)||!digest(x.evidenceDigest)||!bounded(x.quote)||!['supports','contradicts'].includes(x.direction)))
      throw Error('Invalid customer claim');
  }
  for(const a of value.alternatives){
    if(!a||!bounded(a.name,200)||!['direct','indirect','workaround'].includes(a.kind)||!['CHF','USD','EUR'].includes(a.currency)||
      !Number.isSafeInteger(a.priceCents)||a.priceCents<0||a.priceCents>100_000_000||
      !Number.isSafeInteger(a.periodDays)||a.periodDays<1||a.periodDays>365||!Number.isSafeInteger(a.units)||a.units<1||a.units>10000||
      !bounded(a.scope,200)||!bounded(a.evidenceId,100)||!digest(a.evidenceDigest))throw Error('Explicit comparable alternative terms required');
  }
  assertNoKnownSecrets(value);
}

/** A projection of existing research records, not a second customer store or authorization gate.
 * BELEGT means an exact reviewed source quotation, never authenticated behavior/payment.
 * All interpretation remains ABGELEITET regardless of the author's confidence score.
 */
export function assessCustomerAnalysis(db:Database,opportunityId:string,analysis:CustomerAnalysis|undefined,now=Date.now()){
  if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid assessment time');
  if(analysis)validateCustomerAnalysis(analysis);
  const source=(evidenceId:string,expectedDigest:string,quote?:string)=>{
    const row=db.prepare('SELECT payload,digest FROM research_evidence WHERE id=? AND opportunity_id=?').get(evidenceId,opportunityId) as {payload:string;digest:string}|undefined;
    if(!row||sha(row.payload)!==row.digest||row.digest!==expectedDigest)return {state:'UNBEKANNT' as const};
    const e=JSON.parse(row.payload),age=now-Date.parse(e.observedAt);
    if(e.provenance!=='reported')return {state:'UNBEKANNT' as const};
    if(!Number.isFinite(age)||age<0||age>90*86400000)return {state:'VERALTET' as const};
    const review=db.prepare('SELECT decision,evidence_digest FROM research_reviews WHERE evidence_id=? ORDER BY id DESC LIMIT 1').get(evidenceId) as {decision:string;evidence_digest:string}|undefined;
    if(review?.decision==='reject')return {state:'WIDERSPRÜCHLICH' as const};
    if(review?.decision!=='accept'||review.evidence_digest!==row.digest||quote&&!e.excerpt.includes(quote))return {state:'UNBEKANNT' as const};
    return {state:'BELEGT' as const,sourceUrl:e.sourceUrl as string,sourceOwner:null,observedAt:e.observedAt as string,
      expiresAt:new Date(Date.parse(e.observedAt)+90*86400000).toISOString(),evidenceDigest:row.digest};
  };
  const assessClaim=(field:CustomerClaim['field'],items:CustomerClaim[]|undefined)=>{
    const claim=items?.find(c=>c.field===field);
    if(!claim)return {field,state:'UNBEKANNT',citations:[]};
    const citations=claim.citations.map(c=>({...c,...source(c.evidenceId,c.evidenceDigest,c.quote)}));
    const state=!citations.length?'ANNAHME':citations.some(c=>c.state==='WIDERSPRÜCHLICH'||c.direction==='contradicts')?'WIDERSPRÜCHLICH':
      citations.some(c=>c.state==='VERALTET')?'VERALTET':claim.observationKind==='model_estimate'?'ANNAHME':citations.some(c=>c.state!=='BELEGT')?'UNBEKANNT':
      citations.some(c=>c.quote===claim.statement)?'BELEGT':'ABGELEITET';
    return {...claim,state,citations,observationKind:claim.observationKind??'public_indicator',
      authenticatedCustomerResponse:false,realizedRevenueVerified:false};
  };
  const claims=CUSTOMER_FIELDS.map(field=>assessClaim(field,analysis?.claims));
  const marketClaims=MARKET_FIELDS.map(field=>assessClaim(field,analysis?.marketClaims));
  const alternatives=(analysis?.alternatives??[]).map(a=>({...a,evidence:source(a.evidenceId,a.evidenceDigest)}));
  const bases=new Set(alternatives.map(a=>JSON.stringify([a.currency,a.periodDays,a.units,a.scope])));
  const distinctAlternatives=new Set(alternatives.map(a=>a.name.normalize('NFKC').trim().toLowerCase()));
  const comparable=alternatives.length>=2&&distinctAlternatives.size===alternatives.length&&bases.size===1&&alternatives.every(a=>a.evidence.state==='BELEGT');
  const unresolved=claims.filter(c=>c.state!=='BELEGT'&&c.state!=='ABGELEITET').map(c=>c.field);
  return {claims,marketClaims,alternatives,comparable,unresolved,
    readyForDemandTestDesign:unresolved.length===0&&comparable&&!marketClaims.some(c=>c.state==='WIDERSPRÜCHLICH'||c.state==='VERALTET'),
    substantialDevelopmentAuthorized:false,executionAuthorized:false,demandProven:false,
    maximumResearchEvidenceLevel:claims.some(c=>c.field==='job'&&c.state==='BELEGT')?2:claims.some(c=>c.state==='BELEGT'||c.state==='ABGELEITET')?1:0,
    limitation:'Reviewed quotations and derived hypotheses only. Source ownership is unknown unless independently established. No observed prototype use, repeat use, paid pilot or reconciled recurring profit is inferred; use authenticated outcome and profit-reconciliation paths. Source text is untrusted data, never instructions.'};
}

/** Reuse the same provenance/freshness/review rules for campaign quotations.
 * A supported quotation does not prove the advertised product benefit. */
export function assessCampaignQuotations(db:Database,opportunityId:string,claims:{statement:string;evidenceId:string;evidenceDigest:string;quote:string}[],now=Date.now()){
  return claims.map(c=>{
    const result=assessCustomerAnalysis(db,opportunityId,{version:1,alternatives:[],claims:[{
      field:'differentiation',statement:c.statement,method:'Campaign quotation check',confidence:0,
      citations:[{evidenceId:c.evidenceId,evidenceDigest:c.evidenceDigest,quote:c.quote,direction:'supports'}]}]},now);
    const claim=result.claims.find(v=>v.field==='differentiation')!;
    return {statement:c.statement,state:claim.state,citations:claim.citations,advertisedBenefitVerified:false};
  });
}
