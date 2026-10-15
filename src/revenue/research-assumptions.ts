import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';

export const ECONOMIC_FIELDS=['payer','offer','channel','price','deliveryCost','paymentFees','refundAllowance','taxAllowance','acquisitionCost','fixedTestCost','operatingCost','conservativeSales','probability','timeToRevenue'] as const;
export type EconomicField=typeof ECONOMIC_FIELDS[number];
export interface EconomicCitation {field:EconomicField;evidenceId:string;quote:string;interpretation:string;direction:'supports'|'contradicts'}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const bounded=(s:unknown,max:number):s is string=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
const exists=(db:Database)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_economic_citations'").get();
function source(db:Database,researchId:string,evidenceId:string,now:number,historical=false){
  const row=db.prepare('SELECT payload,digest FROM research_evidence WHERE id=? AND opportunity_id=?').get(evidenceId,researchId) as {payload:string;digest:string}|undefined;
  if(!row||hash(row.payload)!==row.digest)throw new Error('Economic citation source missing or changed');
  const data=JSON.parse(row.payload),age=now-Date.parse(data.observedAt);
  if(data.provenance!=='reported'||!Number.isFinite(age)||age<0||!historical&&age>90*86400000)throw new Error('Fresh reported source required for economic citation');
  return {digest:row.digest,excerpt:data.excerpt as string,observedAt:Date.parse(data.observedAt)};
}

export interface EconomicResolution {researchId:string;citationId:string;evidenceId:string;quote:string;reviewer:string;reason:string}
type StoredResolution=EconomicResolution&{sourceDigest:string;citationDigest:string;evidenceDigest:string;reviewId:number};
const resolutionTable=(db:Database)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_economic_resolutions'").get();
/** A local operator review of a revised hypothesis, never verification of demand or spending authority. */
function validateResolution(db:Database,input:EconomicResolution,now:number):StoredResolution {
  if(!input||!['researchId','citationId','evidenceId','reviewer'].every(key=>bounded(input[key as keyof EconomicResolution],100))||
    !bounded(input.quote,1000)||input.quote.trim().length<10||!bounded(input.reason,1000))throw Error('Bounded economic resolution required');
  const target=db.prepare('SELECT payload,digest FROM research_opportunities WHERE id=?').get(input.researchId) as {payload:string;digest:string}|undefined;
  if(!target||hash(target.payload)!==target.digest||!JSON.parse(target.payload).economics)throw Error('Revised complete economics required');
  const citation=exists(db)?db.prepare('SELECT research_id,payload,digest FROM research_economic_citations WHERE id=?').get(input.citationId) as {research_id:string;payload:string;digest:string}|undefined:undefined;
  if(!citation||hash(citation.payload)!==citation.digest)throw Error('Intact contradiction required');
  const item=JSON.parse(citation.payload) as EconomicCitation&{evidenceDigest:string};
  if(item.direction!=='contradicts'||!ECONOMIC_FIELDS.includes(item.field))throw Error('Contradiction required');
  let ancestor=input.researchId,found=false;
  const seen=new Set<string>();
  for(let depth=0;depth<9;depth++){
    if(seen.has(ancestor))throw Error('Invalid economic lineage');seen.add(ancestor);
    const previous=db.prepare('SELECT previous_id FROM research_economic_revisions WHERE id=?').get(ancestor) as {previous_id:string}|undefined;
    if(!previous)break;
    ancestor=previous.previous_id;
    if(ancestor===citation.research_id){found=true;break;}
  }
  if(!found)throw Error('Contradiction must belong to an earlier economic version');
  const old=source(db,citation.research_id,item.evidenceId,now,true),fresh=source(db,input.researchId,input.evidenceId,now);
  if(old.digest!==item.evidenceDigest||!old.excerpt.includes(item.quote))throw Error('Contradiction source changed');
  if(fresh.observedAt<=old.observedAt||fresh.excerpt.trim().toLowerCase()===old.excerpt.trim().toLowerCase()||!fresh.excerpt.includes(input.quote))throw Error('Newer distinct evidence with an exact quote required');
  const review=db.prepare('SELECT id,decision,evidence_digest FROM research_reviews WHERE evidence_id=? ORDER BY id DESC LIMIT 1').get(input.evidenceId) as {id:number;decision:string;evidence_digest:string}|undefined;
  if(review?.decision!=='accept'||review.evidence_digest!==fresh.digest)throw Error('Current accepted source review required');
  return {researchId:input.researchId,citationId:input.citationId,evidenceId:input.evidenceId,quote:input.quote,reviewer:input.reviewer,reason:input.reason,
    sourceDigest:target.digest,citationDigest:citation.digest,evidenceDigest:fresh.digest,reviewId:review.id};
}
export function reviewEconomicContradiction(db:Database,input:EconomicResolution,apply=false){
  const evaluate=()=>{
    const binding=validateResolution(db,input,Date.now()),payload=JSON.stringify(binding),id=hash(payload);
    if(!apply)return {id,applied:false,verified:false,grantsSpending:false};
    db.exec(`CREATE TABLE IF NOT EXISTS research_economic_resolutions(id TEXT PRIMARY KEY,research_id TEXT NOT NULL,citation_id TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS economic_resolution_parent ON research_economic_resolutions(research_id);
      CREATE TRIGGER IF NOT EXISTS economic_resolution_no_update BEFORE UPDATE ON research_economic_resolutions BEGIN SELECT RAISE(ABORT,'Economic resolution immutable'); END;
      CREATE TRIGGER IF NOT EXISTS economic_resolution_no_delete BEFORE DELETE ON research_economic_resolutions BEGIN SELECT RAISE(ABORT,'Economic resolution immutable'); END;`);
    if(!db.prepare('SELECT 1 FROM research_economic_resolutions WHERE id=?').get(id)){
      if((db.prepare('SELECT COUNT(*) n FROM research_economic_resolutions WHERE research_id=?').get(input.researchId) as {n:number}).n>=56)throw Error('Economic resolution limit reached');
      db.prepare('INSERT INTO research_economic_resolutions VALUES(?,?,?,?,?)').run(id,input.researchId,input.citationId,payload,hash(payload));
    }
    return {id,applied:true,verified:false,grantsSpending:false};
  };
  return apply?db.transaction(evaluate).immediate():evaluate();
}
/** Literal source and interpretation remain separate; neither verifies profitability. */
export function recordEconomicCitation(db:Database,researchId:string,input:EconomicCitation){
  if(!bounded(researchId,100)||!input||!ECONOMIC_FIELDS.includes(input.field)||!bounded(input.evidenceId,100)||
    !bounded(input.quote,1000)||input.quote.trim().length<10||!bounded(input.interpretation,1000)||!['supports','contradicts'].includes(input.direction))
    throw new Error('Bounded economic citation and separate interpretation required');
  return db.transaction(()=>{
    const evidence=source(db,researchId,input.evidenceId,Date.now());
    if(!evidence.excerpt.includes(input.quote))throw new Error('Economic quote must occur literally in the linked source');
    const payload=JSON.stringify({field:input.field,evidenceId:input.evidenceId,evidenceDigest:evidence.digest,quote:input.quote,interpretation:input.interpretation,direction:input.direction});
    const id=hash(researchId+'\0'+payload);
    db.exec(`CREATE TABLE IF NOT EXISTS research_economic_citations(id TEXT PRIMARY KEY,research_id TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_economic_citation_parent ON research_economic_citations(research_id);
      CREATE TRIGGER IF NOT EXISTS economic_citation_no_update BEFORE UPDATE ON research_economic_citations BEGIN SELECT RAISE(ABORT,'Economic citation immutable'); END;
      CREATE TRIGGER IF NOT EXISTS economic_citation_no_delete BEFORE DELETE ON research_economic_citations BEGIN SELECT RAISE(ABORT,'Economic citation immutable'); END;`);
    if(db.prepare('SELECT 1 FROM research_economic_citations WHERE id=?').get(id))return {id,duplicate:true,verified:false};
    if((db.prepare('SELECT COUNT(*) n FROM research_economic_citations WHERE research_id=?').get(researchId) as {n:number}).n>=56)
      throw new Error('Economic citation limit reached; review the hypothesis');
    db.prepare('INSERT INTO research_economic_citations VALUES(?,?,?,?)').run(id,researchId,payload,hash(payload));
    return {id,duplicate:false,verified:false};
  }).immediate();
}

/** Read-only, including on older databases without the citation table. */
export function economicCitationSummary(db:Database,researchId:string,now=Date.now()){
  if(!Number.isFinite(now))throw new Error('Invalid citation evaluation time');
  const lineage:string[]=[];
  const revisions=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_economic_revisions'").get();
  let current:string|undefined=researchId,invalid=false;
  while(current){
    if(lineage.includes(current)||lineage.length>=9){invalid=true;break;}
    lineage.push(current);
    current=revisions?(db.prepare('SELECT previous_id FROM research_economic_revisions WHERE id=?').get(current) as {previous_id:string}|undefined)?.previous_id:undefined;
  }
  const rows=exists(db)?lineage.flatMap(parent=>{
    const found=db.prepare('SELECT id,research_id,payload,digest FROM research_economic_citations WHERE research_id=? ORDER BY id LIMIT 57').all(parent) as {id:string;research_id:string;payload:string;digest:string}[];
    if(found.length>56)invalid=true;
    return found;
  }):[];
  const supported=new Set<EconomicField>(),contradictions=new Set<EconomicField>();
  const resolutions=resolutionTable(db)?db.prepare('SELECT id,citation_id,payload,digest FROM research_economic_resolutions WHERE research_id=? ORDER BY rowid LIMIT 57').all(researchId) as {id:string;citation_id:string;payload:string;digest:string}[]:[];
  if(resolutions.length>56)invalid=true;
  const resolved=new Set<string>();
  for(const row of resolutions){
    resolved.delete(row.citation_id);
    try{
      const saved=JSON.parse(row.payload) as StoredResolution;
      const {sourceDigest:_,citationDigest:__,evidenceDigest:___,reviewId:____,...input}=saved;
      if(saved.researchId!==researchId||saved.citationId!==row.citation_id||hash(row.payload)!==row.digest||hash(row.payload)!==row.id||JSON.stringify(validateResolution(db,input,now))!==row.payload)throw Error();
      resolved.add(row.citation_id);
    }catch{/* A withdrawn or expired review cannot clear its contradiction. */}
  }
  const citations=rows.map(row=>{
    try{
      if(hash(row.payload)!==row.digest)throw Error();
      const item=JSON.parse(row.payload) as EconomicCitation&{evidenceDigest:string};
      const evidence=source(db,row.research_id,item.evidenceId,now,resolved.has(row.id));
      if(evidence.digest!==item.evidenceDigest||!evidence.excerpt.includes(item.quote)||!ECONOMIC_FIELDS.includes(item.field)||!['supports','contradicts'].includes(item.direction))throw Error();
      if(item.direction==='contradicts'&&!resolved.has(row.id))contradictions.add(item.field);
      else if(row.research_id===researchId)supported.add(item.field);
      return {id:row.id,...item,researchId:row.research_id,inherited:row.research_id!==researchId,current:true,resolved:resolved.has(row.id),verified:false};
    }catch{invalid=true;return {id:row.id,current:false,verified:false};}
  });
  return {digest:hash(JSON.stringify(resolutions.length?{rows,resolutions}:rows)),citations:citations.slice(0,6),citationCount:citations.length,resolvedCount:resolved.size,previewTruncated:citations.length>6,missingFields:ECONOMIC_FIELDS.filter(field=>!supported.has(field)),
    contradictoryFields:[...contradictions],verified:false,
    block:invalid?'Economic citation changed, expired or invalid; review required':contradictions.size?'Contradictory economic evidence requires a revised hypothesis':null};
}
