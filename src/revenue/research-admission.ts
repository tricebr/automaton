import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {economicCitationSummary} from './research-assumptions.js';
import {assessRevenuePath} from './revenue-paths.js';
import {assessCustomerAnalysis} from './customer-analysis.js';

/** Revisions preserve history, but only the latest economic version may propose new work. */
export function researchEconomicVersionBlock(db:Database,researchId:string,now=Date.now()):string|undefined {
  if(!Number.isFinite(now))return 'Invalid research revalidation time';
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_economic_revisions'").get())return;
  const lineage=db.prepare('SELECT root_id FROM research_economic_revisions WHERE id=?').get(researchId) as {root_id:string}|undefined;
  const latest=db.prepare('SELECT id FROM research_economic_revisions WHERE root_id=? ORDER BY rowid DESC LIMIT 1').get(lineage?.root_id??researchId) as {id:string}|undefined;
  if(latest&&latest.id!==researchId)return 'Research economics superseded; review the latest cost and demand assumptions';
  // Old immutable revisions may predate provenance preservation. Inspect the
  // whole bounded lineage; a new revision cannot silently repair lost origins.
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  const rootId=lineage?.root_id??researchId;
  const seen=new Set<string>();let current=researchId;
  try{
    while(true){
      if(seen.has(current)||seen.size>8)throw Error();
      seen.add(current);
      const source=db.prepare('SELECT payload,digest FROM research_opportunities WHERE id=?').get(current) as {payload:string;digest:string}|undefined;
      if(!source||hash(source.payload)!==source.digest||JSON.parse(source.payload).id!==current)throw Error();
      // Revisions copy evidence once. Later counter-evidence on an ancestor
      // must still invalidate its descendants until explicitly reassessed.
      if(current!==researchId){
        const accepted=db.prepare(`SELECT e.payload,e.digest,r.evidence_digest FROM research_evidence e
          JOIN research_reviews r ON r.id=(SELECT MAX(id) FROM research_reviews WHERE evidence_id=e.id)
          WHERE e.opportunity_id=? AND r.decision='accept' LIMIT 1001`).all(current) as {payload:string;digest:string;evidence_digest:string}[];
        if(accepted.length>1000)throw Error();
        for(const row of accepted){
          if(hash(row.payload)!==row.digest||row.evidence_digest!==row.digest)throw Error();
          const evidence=JSON.parse(row.payload),age=now-Date.parse(evidence.observedAt);
          if(evidence.kind==='rejection'&&evidence.provenance==='reported'&&Number.isFinite(age)&&age>=0&&age<=90*86400000)
            return 'Reviewed rejection in research ancestry requires explicit reassessment';
        }
      }
      const parent=db.prepare('SELECT previous_id,root_id FROM research_economic_revisions WHERE id=?').get(current) as {previous_id:string;root_id:string}|undefined;
      if(!parent){
        // An absent intermediate revision is not a new root. The chain must
        // terminate at the root declared by every immutable revision.
        if(current!==rootId)throw Error();
        break;
      }
      if(parent.root_id!==rootId)throw Error();
      const rows=db.prepare('SELECT id,payload,digest FROM research_evidence WHERE opportunity_id=? LIMIT 1001').all(parent.previous_id) as {id:string;payload:string;digest:string}[];
      if(rows.length>1000)throw Error();
      for(const row of rows){
        if(hash(row.payload)!==row.digest)throw Error();
        const evidence=JSON.parse(row.payload);
        if(evidence.originUrl===undefined)continue;
        const childId=`econev-${hash(current+row.id).slice(0,40)}`;
        const child=db.prepare('SELECT payload,digest FROM research_evidence WHERE id=? AND opportunity_id=?').get(childId,current) as {payload:string;digest:string}|undefined;
        if(!child||hash(child.payload)!==child.digest||JSON.parse(child.payload).originUrl!==evidence.originUrl)throw Error();
      }
      current=parent.previous_id;
    }
  }catch{return 'Research revision provenance missing or changed; explicit source reassessment required';}
}

/** Read-only guard for research-derived experiments. Ordinary experiments retain their existing guards. */
export function researchAdmissionBlock(db:Database,experimentId:string):string|undefined {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_research_experiments'").get())return;
  const original=db.prepare('SELECT research_id,snapshot FROM obolus_research_experiments WHERE experiment_id=?').get(experimentId);
  const revisions=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_research_plan_revisions'").get();
  const mapping=(original??(revisions?db.prepare('SELECT research_id,snapshot FROM obolus_research_plan_revisions WHERE experiment_id=?').get(experimentId):undefined)) as {research_id:string;snapshot:string}|undefined;
  if(!mapping)return;
  const economicBlock=researchEconomicVersionBlock(db,mapping.research_id);
  if(economicBlock)return economicBlock;
  if(revisions) {
    const latest=db.prepare('SELECT experiment_id FROM obolus_research_plan_revisions WHERE research_id=? ORDER BY id DESC LIMIT 1').get(mapping.research_id) as {experiment_id:string}|undefined;
    if(latest&&latest.experiment_id!==experimentId)return 'Research plan superseded; predecessor cannot be admitted';
  }
  try {
    const snapshot=JSON.parse(mapping.snapshot);
    const economicEvidence=economicCitationSummary(db,mapping.research_id);
    if(economicEvidence.block)return economicEvidence.block;
    if(snapshot.economicEvidenceDigest!==economicEvidence.digest&&(snapshot.economicEvidenceDigest!==undefined||economicEvidence.citations.length))
      return 'Economic evidence changed; explicit plan revision required';
    const source=db.prepare('SELECT payload,digest FROM research_opportunities WHERE id=?').get(mapping.research_id) as {payload:string;digest:string}|undefined;
    const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
    if(!source||source.digest!==snapshot.sourceDigest||hash(source.payload)!==source.digest)throw Error();
    // Revalidate new counter-evidence as well as the positive reviews saved in
    // the plan. A later rejection must not leave an old handoff admissible.
    const currentEvidence=db.prepare(`SELECT e.payload,e.digest,r.evidence_digest FROM research_evidence e
      JOIN research_reviews r ON r.id=(SELECT MAX(id) FROM research_reviews WHERE evidence_id=e.id)
      WHERE e.opportunity_id=? AND r.decision='accept'`).all(mapping.research_id) as
      {payload:string;digest:string;evidence_digest:string}[];
    for(const row of currentEvidence){
      if(hash(row.payload)!==row.digest||row.evidence_digest!==row.digest)throw Error();
      const evidence=JSON.parse(row.payload),age=Date.now()-Date.parse(evidence.observedAt);
      if(evidence.kind==='rejection'&&evidence.provenance==='reported'&&Number.isFinite(age)&&age>=0&&age<=90*86400000)
        return 'Reviewed rejection requires reassessment before experiment admission';
    }
    const opportunity=JSON.parse(source.payload);
    if(opportunity.customerAnalysis&&!assessCustomerAnalysis(db,mapping.research_id,opportunity.customerAnalysis).readyForDemandTestDesign)
      return 'Customer analysis requires current complete evidence and comparable alternatives';
    const path=opportunity.revenuePath;
    if(path){
      const assessment=assessRevenuePath(db,path);
      if(assessment.blockers.length)return `Revenue path HOLD: ${assessment.blockers.join('; ')}`;
      return 'Revenue path local preparation only; external execution requires separate authorization';
    }
    const binding=db.prepare(`SELECT 1 FROM obolus_research_handoffs h JOIN revenue_experiments e ON e.opportunity_id=h.opportunity_id
      WHERE h.research_id=? AND e.id=?`).get(mapping.research_id,experimentId);
    if(!binding||!Array.isArray(snapshot.reviews)||snapshot.reviews.length<2||snapshot.reviews.length>1000)throw Error();
    const hosts=new Set<string>(),excerpts=new Set<string>(),origins=new Set<string>();
    for(const saved of snapshot.reviews) {
      const review=db.prepare('SELECT id,decision,evidence_digest FROM research_reviews WHERE evidence_id=? ORDER BY id DESC LIMIT 1').get(saved.evidence_id) as {id:number;decision:string;evidence_digest:string}|undefined;
      const row=db.prepare('SELECT payload,digest FROM research_evidence WHERE id=? AND opportunity_id=?').get(saved.evidence_id,mapping.research_id) as {payload:string;digest:string}|undefined;
      if(!review||review.id!==saved.id||review.decision!=='accept'||!row||review.evidence_digest!==row.digest||saved.evidence_digest!==row.digest||hash(row.payload)!==row.digest)throw Error();
      const evidence=JSON.parse(row.payload),age=Date.now()-Date.parse(evidence.observedAt);
      if(evidence.provenance!=='reported'||!Number.isFinite(age)||age<0||age>90*86400000)throw Error();
      const host=new URL(evidence.sourceUrl).hostname.toLowerCase().replace(/^www\./,'');
      const excerpt=hash(evidence.excerpt.trim().toLowerCase().replace(/\s+/g,' '));
      // Mirrors rank(): syndication does not create independent demand even
      // when the publishing host and wording differ from the original.
      const origin=evidence.originUrl??evidence.sourceUrl;
      if(hosts.has(host)||excerpts.has(excerpt)||origins.has(origin))throw Error();
      hosts.add(host);excerpts.add(excerpt);origins.add(origin);
    }
  }catch{return 'Research evidence changed, expired or was withdrawn; explicit experiment review required';}
}
