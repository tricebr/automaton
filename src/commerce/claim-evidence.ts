import {createHash} from 'node:crypto';
import {assertNoKnownSecrets} from '../observability/redaction.js';

export const CLAIM_TYPES=['function','price','benefit','comparison','performance','finance','security_privacy','testimonial','opinion'] as const;
export const CLAIM_STATES=['BELEGT','EINGESCHRÄNKT_BELEGT','ANNAHME','WIDERSPRÜCHLICH','VERALTET','UNBEKANNT'] as const;
export const OBSERVATION_CLASSES=['PROGNOSE','SIMULATION','LOKALE_FIXTURE','EXTERN_BEOBACHTET','ABGESTIMMT','UNBEKANNT'] as const;
export interface PublicationContext {
  audience:string;language:string;region:string;channel:string;variant:string;
}
export interface ClaimTarget extends PublicationContext {
  productDigest:string;requirementsDigest:string;payloadDigest:string;
  assertions?:{statement:string;type?:typeof CLAIM_TYPES[number]}[];
}
export interface ClaimEvidence {
  statement:string;type:typeof CLAIM_TYPES[number];status:typeof CLAIM_STATES[number];
  target:ClaimTarget;source:string;sourceDigest:string;observedAt:number;expiresAt:number;
  method:'functional_test'|'price_verification'|'controlled_measurement'|'comparative_measurement'|'settled_records'|'security_review'|'authenticated_testimonial'|'opinion_label';
  provenance:typeof OBSERVATION_CLASSES[number];confidence:number;
  /** Immutable content capture, treated as data only; a URL alone is insufficient. */
  sourceContent:string;qualification:string|null;
  testimonial?:{originVerified:boolean;useAuthorized:boolean;authorizationDigest:string};
}
export interface PublicationClaims {
  target:ClaimTarget;
  /** Trusted independent inventory of ALL material assertions in the exact payload.
   * This is not an LLM assertion or automatic truth detector. */
  inventoryComplete:true;inventoryReviewer:string;claims:ClaimEvidence[];
}
export const claimDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown,max=200):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max;
export function validatePublicationContext(c:PublicationContext){
  if(!c||!['audience','language','region','channel','variant'].every(k=>text(c[k as keyof PublicationContext]))||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(c.language)||!/^(?:[A-Z]{2}|GLOBAL)$/.test(c.region))throw Error('Explicit publication audience, language, region, channel and variant required');
  assertNoKnownSecrets(c);
}
function validateTarget(t:ClaimTarget){
  validatePublicationContext(t);
  if(![t.productDigest,t.requirementsDigest,t.payloadDigest].every(hash))throw Error('Exact publication digests required');
  if(t.assertions!==undefined&&(!Array.isArray(t.assertions)||!t.assertions.length||t.assertions.length>100||t.assertions.some(a=>!a||!text(a.statement,4000)||a.type!==undefined&&!CLAIM_TYPES.includes(a.type))))throw Error('Invalid required publication assertions');
}
const methods:Record<typeof CLAIM_TYPES[number],readonly ClaimEvidence['method'][]>={
  function:['functional_test'],price:['price_verification'],benefit:['controlled_measurement'],
  comparison:['comparative_measurement'],performance:['controlled_measurement'],finance:['settled_records'],
  security_privacy:['security_review'],testimonial:['authenticated_testimonial'],opinion:['opinion_label'],
};
/** Structural validation does not attest external truth. Only the existing trusted
 * review registration path may store this contract. No source text is executed. */
export function validatePublicationClaims(p:PublicationClaims){
  if(!p||p.inventoryComplete!==true||!text(p.inventoryReviewer)||!Array.isArray(p.claims)||!p.claims.length||p.claims.length>100)throw Error('Complete independently reviewed claim inventory required');
  validateTarget(p.target);assertNoKnownSecrets(p);
  if(Buffer.byteLength(JSON.stringify(p))>262144)throw Error('Claim evidence exceeds bounded review size');
  const seen=new Set<string>();
  for(const c of p.claims){
    if(!c||!text(c.statement,4000)||!CLAIM_TYPES.includes(c.type)||!CLAIM_STATES.includes(c.status)||
      !OBSERVATION_CLASSES.includes(c.provenance)||!methods[c.type].includes(c.method)||
      !Number.isFinite(c.confidence)||c.confidence<0||c.confidence>1||!hash(c.sourceDigest)||
      !text(c.sourceContent,16000)||!text(c.source,2000)||
      !Number.isSafeInteger(c.observedAt)||c.observedAt<0||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=c.observedAt||
      c.expiresAt-c.observedAt>7*86400000||c.qualification!==null&&!text(c.qualification,2000))throw Error('Invalid typed claim evidence');
    validateTarget(c.target);
    if(claimDigest(c.target)!==claimDigest(p.target)||createHash('sha256').update(c.sourceContent).digest('hex')!==c.sourceDigest)throw Error('Claim evidence scope or capture integrity mismatch');
    const url=new URL(c.source);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid claim evidence source');
    if(seen.has(c.statement))throw Error('Duplicate claim in inventory');seen.add(c.statement);
    if(c.type==='testimonial'&&(!c.testimonial||c.testimonial.originVerified!==true||c.testimonial.useAuthorized!==true||!hash(c.testimonial.authorizationDigest)))throw Error('Authenticated testimonial and lawful-use evidence required');
  }
}
/** No profit/score field participates. Limited proof requires revised, qualified
 * copy and a new BELEGT review; it is not an automatic permission to publish. */
export function publicationClaimsDecision(p:PublicationClaims|undefined,target:ClaimTarget|undefined,now:number){
  if(!p||!target)return 'CLAIM_REVIEW_ABSENT';
  try{validatePublicationClaims(p);validateTarget(target);}catch{return 'CLAIM_EVIDENCE_INVALID';}
  if(claimDigest(p.target)!==claimDigest(target))return 'CLAIM_SCOPE_MISMATCH';
  if(target.assertions?.some(a=>!p.claims.some(c=>c.statement===a.statement&&(!a.type||c.type===a.type))))return 'CLAIM_INVENTORY_INCOMPLETE';
  if(p.claims.some(c=>c.observedAt>now||c.expiresAt<=now))return 'CLAIM_REVALIDATION_REQUIRED';
  if(p.claims.some(c=>c.status!=='BELEGT'))return 'CLAIM_NOT_SUPPORTED';
  if(p.claims.some(c=>c.type==='opinion'?!c.qualification||!c.statement.includes(c.qualification):!['EXTERN_BEOBACHTET','ABGESTIMMT'].includes(c.provenance)))return 'CLAIM_NOT_EXTERNAL_EVIDENCE';
  return null;
}
