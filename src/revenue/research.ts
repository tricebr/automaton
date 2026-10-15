import {marketDecisionReport} from './market-decision.js';
import {assessRevenuePath,prepareRevenuePathDraft,validateRevenuePath,type RevenuePathAssessment} from './revenue-paths.js';
import {assertNoPersonnelCostInputs} from './personnel-cost-policy.js';
import {economicCitationSummary} from './research-assumptions.js';
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import {assessMarketingPlan,type MarketingPlan} from './marketing.js';
import {researchEconomicVersionBlock} from './research-admission.js';
import {designValidation} from './validation-design.js';
import {suggestEconomicSources} from './research-source-suggestions.js';
import {assessCustomerAnalysis,assessCampaignQuotations,validateCustomerAnalysis,type CustomerAnalysis} from './customer-analysis.js';

export const RESEARCH_SECTORS = ["software", "saas", "ai-automation", "digital-products", "b2b-services", "data-products", "marketplaces", "market-research"] as const;
export interface ResearchOpportunity {
  id: string; title: string; sector: typeof RESEARCH_SECTORS[number]; hypothesis: string;
  forecast: { revenueCents: number; costCents: number; probability: number; days: number; validationBudgetCents: number };
  forecastState?: 'unknown';
  economics?: MarketingPlan;
  customerAnalysis?: CustomerAnalysis;
  revenuePath?: RevenuePathAssessment;
}
export interface DemandEvidence {
  /** Original public record for known syndication; bound by the evidence review. */
  originUrl?: string;
  id: string; opportunityId: string; sourceUrl: string; observedAt: string;
  kind: "request" | "commitment" | "payment_claim" | "rejection" | "method"; excerpt: string;
  provenance: "reported" | "synthetic"; reviewedBy: string | null;
}
export interface ResearchDossier { opportunities: ResearchOpportunity[]; evidence: DemandEvidence[] }
export interface RankedResearch {
  id: string; title: string; sector: string; hypothesis: string;
  independentSources: number; sourceIds: string[]; forecastNetCents: number | null; score: number;
  proposedBudgetCents: number; decision: "validate" | "hold" | "reject"; reason: string;
}
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const cents = (v: number) => Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000;
const digest = (data: string) => createHash("sha256").update(data).digest("hex");

/** Local research only. Imported claims never become revenue or launch authority. */
export class ResearchStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS research_opportunities (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_evidence (
      id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES research_opportunities(id),
      payload TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_evidence_opportunity ON research_evidence(opportunity_id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS research_reviews (
      id INTEGER PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES research_evidence(id),
      reviewer TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('accept','reject')),
      reason TEXT NOT NULL,evidence_digest TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));`);
  }
  import(input: ResearchDossier): { opportunities: number; evidence: number } {
    assertNoPersonnelCostInputs(input?.opportunities);
    if (!input || !Array.isArray(input.opportunities) || !Array.isArray(input.evidence) ||
        input.opportunities.length > 200 || input.evidence.length > 1000) throw new Error("Invalid research dossier size");
    return this.db.transaction(() => {
      let opportunities = 0, evidence = 0;
      for (const o of input.opportunities) {
        if (!o || !id(o.id) || !text(o.title, 200) || !text(o.hypothesis, 2000) || !RESEARCH_SECTORS.includes(o.sector) ||
            !o.forecast || ![o.forecast.revenueCents, o.forecast.costCents, o.forecast.validationBudgetCents].every(cents) ||
            !Number.isFinite(o.forecast.probability) || o.forecast.probability < 0 || o.forecast.probability > 1 ||
            !Number.isInteger(o.forecast.days) || o.forecast.days < 1 || o.forecast.days > 3650) throw new Error("Invalid research opportunity");
        if(o.forecastState!==undefined&&o.forecastState!=='unknown')throw new Error('Invalid forecast state');
        if(o.customerAnalysis!==undefined)validateCustomerAnalysis(o.customerAnalysis);
        if(o.revenuePath!==undefined)validateRevenuePath(o.revenuePath);
        if(o.forecastState==='unknown'&&(o.economics||Object.entries(o.forecast).some(([key,value])=>key!=='days'&&value!==0)))throw new Error('Unknown forecast must not contain financial claims');
        if(o.economics){
          const assessment=assessMarketingPlan(o.economics);
          if(o.economics.currency!=='USD')throw new Error('Research forecasts require USD; explicit conversion before import');
          if(o.forecast.revenueCents!==o.economics.priceCents*o.economics.conservativeSales||
            o.forecast.costCents!==assessment.grossOutlayCents-o.economics.fixedTestCostCents||
            o.forecast.validationBudgetCents!==o.economics.fixedTestCostCents)throw new Error('Forecast must include every economic cost component');
        }
        const payload = JSON.stringify({ id: o.id, title: o.title, sector: o.sector, hypothesis: o.hypothesis,
          forecast: { revenueCents: o.forecast.revenueCents, costCents: o.forecast.costCents, probability: o.forecast.probability,
            days: o.forecast.days, validationBudgetCents: o.forecast.validationBudgetCents },
          ...(o.forecastState?{forecastState:o.forecastState}:{}),...(o.economics?{economics:o.economics}:{}),
          ...(o.customerAnalysis?{customerAnalysis:o.customerAnalysis}:{}),...(o.revenuePath?{revenuePath:o.revenuePath}:{}) });
        opportunities += this.insert("research_opportunities", o.id, payload);
      }
      for (const e of input.evidence) {
        if (!e || !id(e.id) || !id(e.opportunityId) || !text(e.sourceUrl, 2000) || !text(e.excerpt, 4000) ||
            !["request", "commitment", "payment_claim", "rejection", "method"].includes(e.kind) || !["reported", "synthetic"].includes(e.provenance) ||
            (e.reviewedBy !== null && !text(e.reviewedBy, 100)) || !text(e.observedAt, 40) || !Number.isFinite(Date.parse(e.observedAt))) throw new Error("Invalid demand evidence");
        const url = new URL(e.sourceUrl);
        let originUrl:string|undefined;
        if(e.originUrl!==undefined){
          if(!text(e.originUrl,2000))throw Error('Invalid evidence origin');
          const origin=new URL(e.originUrl);
          if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.port)throw Error('Invalid evidence origin');
          originUrl=origin.href;
        }
        const hnItem = url.hostname === "news.ycombinator.com" && url.pathname === "/item" && /^\?id=\d+$/.test(url.search);
        const tenderRecord = url.hostname === 'www.find-tender.service.gov.uk' && url.pathname === '/api/1.0/ocdsReleasePackages' && /^\?ocid=ocds-[A-Za-z0-9-]{1,115}$/.test(url.search);
        if (url.protocol !== "https:" || url.username || url.password || (url.search && !hnItem && !tenderRecord) || url.hash) throw new Error("Use public HTTPS source URLs without credentials or tracking parameters");
        const payload = JSON.stringify({ id: e.id, opportunityId: e.opportunityId, sourceUrl: url.href,
          observedAt: new Date(e.observedAt).toISOString(), kind: e.kind, excerpt: e.excerpt, provenance: e.provenance, reviewedBy: e.reviewedBy,...(originUrl?{originUrl}:{}) });
        evidence += this.insert("research_evidence", e.id, payload, e.opportunityId);
      }
      const counts = this.db.prepare(`SELECT (SELECT COUNT(*) FROM research_opportunities) o,
        (SELECT COUNT(*) FROM research_evidence) e`).get() as { o: number; e: number };
      if (counts.o > 200 || counts.e > 1000) throw new Error("Research workspace capacity reached");
      return { opportunities, evidence };
    }).immediate();
  }
  private insert(table: "research_opportunities" | "research_evidence", key: string, payload: string, opportunity?: string): number {
    const hash = digest(payload);
    const previous = this.db.prepare(`SELECT digest FROM ${table} WHERE id=?`).get(key) as { digest: string } | undefined;
    if (previous) { if (previous.digest !== hash) throw new Error("Conflicting immutable research record; use a new version ID"); return 0; }
    if (opportunity) this.db.prepare("INSERT INTO research_evidence(id,opportunity_id,payload,digest) VALUES(?,?,?,?)").run(key, opportunity, payload, hash);
    else this.db.prepare("INSERT INTO research_opportunities(id,payload,digest) VALUES(?,?,?)").run(key, payload, hash);
    return 1;
  }
  rank(now = Date.now()): RankedResearch[] {
    if (!Number.isFinite(now)) throw new Error("Invalid research evaluation time");
    const rows = this.db.prepare("SELECT payload,digest FROM research_opportunities ORDER BY id").all() as { payload: string;digest:string }[];
    return rows.map(row => {
      if(digest(row.payload)!==row.digest)throw new Error('Research opportunity integrity mismatch');
      const o = JSON.parse(row.payload) as ResearchOpportunity;
      const evidence = (this.db.prepare("SELECT payload,digest FROM research_evidence WHERE opportunity_id=? ORDER BY id").all(o.id) as { payload: string; digest: string }[])
        .map(row => ({ item: JSON.parse(row.payload) as DemandEvidence, hash: row.digest, valid: digest(row.payload) === row.digest }));
      const sources = new Set<string>(), excerpts = new Set<string>(),origins=new Set<string>(); const sourceIds: string[] = [];
      let reviewedRejection=false;
      for (const {item:e,hash,valid} of evidence) {
        const age = now - Date.parse(e.observedAt);
        const review = this.db.prepare("SELECT decision,evidence_digest FROM research_reviews WHERE evidence_id=? ORDER BY id DESC LIMIT 1").get(e.id) as { decision: string; evidence_digest:string } | undefined;
        // Imported reviewer names are claims, not a review performed in this workspace.
        const accepted = valid && review?.decision === "accept" && review.evidence_digest === hash;
        if (e.provenance !== "reported" || !accepted || age < 0 || age > 90 * 86400000) continue;
        if(e.kind==='rejection'){reviewedRejection=true;continue;}
        if(e.kind==='method')continue;
        const host = new URL(e.sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
        // Different pages on the same host and verbatim cross-posts do not
        // multiply demand. Host separation is a heuristic, not identity proof.
        const excerpt = digest(e.excerpt.trim().toLowerCase().replace(/\s+/g, " "));
        const origin=e.originUrl??e.sourceUrl;
        if (sources.has(host) || excerpts.has(excerpt)||origins.has(origin)) continue;
        origins.add(origin);
        sources.add(host); excerpts.add(excerpt); sourceIds.push(e.id);
      }
      const net = o.forecastState==='unknown'?null:Math.floor(o.forecast.revenueCents * o.forecast.probability) - o.forecast.costCents - o.forecast.validationBudgetCents;
      const economics=o.economics?assessMarketingPlan(o.economics):null;
      const blockedEconomics=!!economics?.blockers.length;
      const versionBlock=researchEconomicVersionBlock(this.db,o.id,now);
      const pathAssessment=o.revenuePath?assessRevenuePath(this.db,o.revenuePath,now):null;
      const pathBlock=pathAssessment?.blockers.length?pathAssessment.blockers.join('; '):
        reviewedRejection?'Reviewed rejection requires reassessment of this candidate':null;
      const citationBlock=economicCitationSummary(this.db,o.id,now).block;
      const customerReview=o.customerAnalysis?assessCustomerAnalysis(this.db,o.id,o.customerAnalysis,now):null;
      const customerBlock=customerReview&&!customerReview.readyForDemandTestDesign
        ?'Customer analysis requires current complete evidence and comparable alternatives':null;
      const supported = sources.size >= 2;
      const decision = net===null||pathBlock||versionBlock||citationBlock||customerBlock?'hold':net <= 0||blockedEconomics ? "reject" : supported ? "validate" : "hold";
      return { id: o.id, title: o.title, sector: o.sector, hypothesis: o.hypothesis, independentSources: sources.size, sourceIds,
        forecastNetCents: net, score: net!==null && net > 0 && supported && !pathBlock && !blockedEconomics && !versionBlock && !citationBlock && !customerBlock ? net / o.forecast.days * Math.min(1, sources.size / 3) / Math.max(1, o.forecast.validationBudgetCents / 1000) : 0,
        proposedBudgetCents: o.forecast.validationBudgetCents, decision,
        reason: pathBlock??versionBlock??citationBlock??customerBlock??(net===null?'Economics unknown; establish payer, offer, costs and a bounded decisive test':blockedEconomics?economics!.blockers.join('; '):net <= 0 ? "Risk-adjusted forecast does not cover operating and validation costs" : supported ? "Reviewed reported demand supports a bounded validation proposal; no verified sale" : "At least two fresh reviewed independent source hosts required") } satisfies RankedResearch;
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
  evidence(opportunityId?: string): (DemandEvidence & { digest: string })[] {
    const rows = opportunityId
      ? this.db.prepare("SELECT id,opportunity_id,payload,digest FROM research_evidence WHERE opportunity_id=? ORDER BY id LIMIT 1000").all(opportunityId)
      : this.db.prepare("SELECT id,opportunity_id,payload,digest FROM research_evidence ORDER BY rowid DESC LIMIT 100").all();
    return (rows as { id:string;opportunity_id:string;payload: string; digest: string }[]).map(row => {
      try {
        if(digest(row.payload)!==row.digest)throw Error();
        const value=JSON.parse(row.payload) as DemandEvidence;
        if(!value||value.id!==row.id||value.opportunityId!==row.opportunity_id)throw Error();
        return {...value,digest:row.digest};
      } catch { throw new Error('Research evidence integrity mismatch'); }
    });
  }
  review(evidenceId: string, reviewer: string, decision: "accept" | "reject", reason: string): void {
    if (!id(evidenceId) || !text(reviewer, 100) || !text(reason, 1000) || !["accept", "reject"].includes(decision)) throw new Error("Invalid evidence review");
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT digest,payload FROM research_evidence WHERE id=?").get(evidenceId) as { digest: string; payload: string } | undefined;
      if (!row) throw new Error("Unknown evidence");
      if (digest(row.payload) !== row.digest) throw new Error("Evidence integrity mismatch");
      if (decision === "accept" && (JSON.parse(row.payload) as DemandEvidence).provenance !== "reported") throw new Error("Synthetic evidence cannot be accepted as demand");
      this.db.prepare("INSERT INTO research_reviews(evidence_id,reviewer,decision,reason,evidence_digest) VALUES(?,?,?,?,?)")
        .run(evidenceId, reviewer, decision, reason, row.digest);
    }).immediate();
  }
  /** Structured next work, not a claim that missing business facts have been discovered. */
  economicBrief(opportunityId:string) {
    return this.db.transaction(()=>this.readEconomicBrief(opportunityId))();
  }
  private readEconomicBrief(opportunityId:string) {
    const row=this.db.prepare('SELECT payload,digest FROM research_opportunities WHERE id=?').get(opportunityId) as {payload:string;digest:string}|undefined;
    if(!row||digest(row.payload)!==row.digest)throw new Error('Unknown or corrupted research opportunity');
    const o=JSON.parse(row.payload) as ResearchOpportunity;
    const ranked=this.rank().find(item=>item.id===opportunityId)!;
    const sourceEvidence=this.evidence(opportunityId);
    const evidence=sourceEvidence.map(e=>({id:e.id,digest:e.digest,sourceUrl:e.sourceUrl,observedAt:e.observedAt}));
    const missing=o.economics?[]:['payer','offer','channel','price','deliveryCost','paymentFees','refundAllowance','taxAllowance','acquisitionCost','fixedTestCost','operatingCost','conservativeSales','successCriterion','stopCriterion'];
    const economicEvidence=economicCitationSummary(this.db,opportunityId);
    const sourceSuggestions=suggestEconomicSources(sourceEvidence.map(e=>({...e,reviewDecision:
      (this.db.prepare('SELECT decision FROM research_reviews WHERE evidence_id=? ORDER BY id DESC LIMIT 1').get(e.id) as {decision:string}|undefined)?.decision})),economicEvidence.missingFields);
    const validation=designValidation({decision:ranked.decision,reason:ranked.reason,economics:o.economics,
      missingFields:economicEvidence.missingFields,evidenceBlock:researchEconomicVersionBlock(this.db,opportunityId)??economicEvidence.block,
        contradictoryFields:economicEvidence.contradictoryFields,days:o.forecast.days,forecast:o.forecastState==='unknown'?undefined:o.forecast});
    return {opportunityId,sourceDigest:row.digest,title:o.title,hypothesis:o.hypothesis,evidence:evidence.slice(0,12),
      evidenceCount:evidence.length,evidenceDigest:digest(JSON.stringify(evidence)),evidencePreviewTruncated:evidence.length>12,
      economics:o.economics?assessMarketingPlan(o.economics):null,missing,economicEvidence,validation,sourceSuggestions,
      customerAnalysis:assessCustomerAnalysis(this.db,opportunityId,o.customerAnalysis),
      marketDecision:marketDecisionReport(this.db,opportunityId,o.customerAnalysis,o.economics),
      campaignQuotations:o.economics?.campaign?assessCampaignQuotations(this.db,opportunityId,o.economics.campaign.claims):[],
      forecastNetCents:ranked.forecastNetCents,decision:ranked.decision,reason:ranked.reason,
      nextAction:validation.action,
      test:{success:o.economics?.successCriterion??'Identify a reachable payer with a concrete recurring problem and an attributable willingness-to-pay signal',
        failure:o.economics?.stopCriterion??'No reachable payer or no plausible positive all-in economics: stop this hypothesis',
        maxAuthorizedSpendCents:0,executionAuthorized:false},
      revenuePath:o.revenuePath?assessRevenuePath(this.db,o.revenuePath):null,
      revenuePathDraft:o.revenuePath?prepareRevenuePathDraft(this.db,o.revenuePath):null,
      outcomeLearning:this.outcomeLearning(opportunityId),
      profitabilityProven:false,assumptions:'Supplied prices, sales and costs remain assumptions; source citations are not verification of each economic claim'};
  }
  /** Descriptive evidence only; settlement learning stays in the reconciled ledger. */
  outcomeLearning(opportunityId:string,now=Date.now()){
    if(!id(opportunityId)||!Number.isSafeInteger(now))throw Error('Invalid learning scope');
    const groups:{rejections:string[];commitments:string[];paymentClaims:string[];excluded:string[]}={rejections:[],commitments:[],paymentClaims:[],excluded:[]};
    for(const e of this.evidence(opportunityId)){
      if(e.kind==='request'||e.kind==='method')continue;
      const review=this.db.prepare('SELECT decision,evidence_digest FROM research_reviews WHERE evidence_id=? ORDER BY id DESC LIMIT 1').get(e.id) as {decision:string;evidence_digest:string}|undefined;
      const age=now-Date.parse(e.observedAt);
      if(e.provenance!=='reported'||review?.decision!=='accept'||review.evidence_digest!==e.digest||age<0||age>90*86400000){groups.excluded.push(e.id);continue;}
      groups[e.kind==='rejection'?'rejections':e.kind==='commitment'?'commitments':'paymentClaims'].push(e.id);
    }
    return {...groups,nextCheck:groups.rejections.length?'Reassess rejected scope and counter-evidence before further validation':'Validate assumptions against independent outcomes',
      realizedRevenueCents:null,executionAuthorized:false,limitation:'Reviewed reports are not settled payments, conversion rates or causal proof. Reconciled cash learning uses Profit Ledger and businessLearningProjection.'};
  }
  /** New immutable forecast version; never edits the source, inherits reviews or grants funding. */
  reviseEconomics(opportunityId:string,plan:MarketingPlan,probability:number,days:number,reason:string) {
    if(!id(opportunityId)||!text(reason,1000)||!Number.isFinite(probability)||probability<0||probability>1||!Number.isInteger(days)||days<1||days>3650)
      throw new Error('Bounded economic revision and rationale required');
    const assessment=assessMarketingPlan(plan);
    if(plan.currency!=='USD')throw new Error('Research forecasts require USD; explicit conversion before import');
    return this.db.transaction(()=>{
      const brief=this.economicBrief(opportunityId);
      if(!brief.evidence.length)throw new Error('Source evidence required before economic revision');
      this.db.exec(`CREATE TABLE IF NOT EXISTS research_economic_revisions(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,previous_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
        CREATE INDEX IF NOT EXISTS research_economic_revision_root ON research_economic_revisions(root_id);
        CREATE TRIGGER IF NOT EXISTS research_economic_revision_no_update BEFORE UPDATE ON research_economic_revisions BEGIN SELECT RAISE(ABORT,'Economic revision immutable'); END;
        CREATE TRIGGER IF NOT EXISTS research_economic_revision_no_delete BEFORE DELETE ON research_economic_revisions BEGIN SELECT RAISE(ABORT,'Economic revision immutable'); END;`);
      const prior=this.db.prepare('SELECT root_id FROM research_economic_revisions WHERE id=?').get(opportunityId) as {root_id:string}|undefined;
      const rootId=prior?.root_id??opportunityId;
      const versionId=`econ-${digest(JSON.stringify([brief.sourceDigest,plan,probability,days,reason,brief.evidenceDigest,brief.economicEvidence.digest])).slice(0,40)}`;
      if(this.db.prepare('SELECT 1 FROM research_economic_revisions WHERE id=?').get(versionId))return {id:versionId,duplicate:true,brief:this.economicBrief(versionId)};
      if((this.db.prepare('SELECT COUNT(*) n FROM research_economic_revisions WHERE root_id=?').get(rootId) as {n:number}).n>=8)
        throw new Error('Economic revision limit reached; reassess the underlying hypothesis');
      const source=JSON.parse((this.db.prepare('SELECT payload FROM research_opportunities WHERE id=?').get(opportunityId) as {payload:string}).payload) as ResearchOpportunity;
      const previousEvidence=this.evidence(opportunityId);
      const revisedEvidence=previousEvidence.map(e=>({id:`econev-${digest(versionId+e.id).slice(0,40)}`,opportunityId:versionId,
        sourceUrl:e.sourceUrl,observedAt:e.observedAt,kind:e.kind,excerpt:e.excerpt,provenance:e.provenance,reviewedBy:null,
        ...(e.originUrl?{originUrl:e.originUrl}:{})}));
      const rebind=<T extends {evidenceId:string;evidenceDigest:string}>(reference:T):T=>{
        const index=previousEvidence.findIndex(e=>e.id===reference.evidenceId&&e.digest===reference.evidenceDigest);
        return index<0?reference:{...reference,evidenceId:revisedEvidence[index].id,evidenceDigest:digest(JSON.stringify(revisedEvidence[index]))};
      };
      const customerAnalysis=source.customerAnalysis?{...source.customerAnalysis,
        claims:source.customerAnalysis.claims.map(c=>({...c,citations:c.citations.map(rebind)})),
        marketClaims:source.customerAnalysis.marketClaims?.map(c=>({...c,citations:c.citations.map(rebind)})),
        alternatives:source.customerAnalysis.alternatives.map(rebind)}:undefined;
      const opportunity:ResearchOpportunity={id:versionId,title:source.title,sector:source.sector,hypothesis:source.hypothesis,economics:structuredClone(plan),
        ...(customerAnalysis?{customerAnalysis}:{}),...(source.revenuePath?{revenuePath:source.revenuePath}:{}),
        forecast:{revenueCents:plan.priceCents*plan.conservativeSales,costCents:assessment.grossOutlayCents-plan.fixedTestCostCents,
          validationBudgetCents:plan.fixedTestCostCents,probability,days}};
      this.import({opportunities:[opportunity],evidence:revisedEvidence});
      this.db.prepare('INSERT INTO research_economic_revisions(id,root_id,previous_id,reason) VALUES(?,?,?,?)').run(versionId,rootId,opportunityId,reason);
      return {id:versionId,duplicate:false,brief:this.economicBrief(versionId)};
    }).immediate();
  }
  plan(proposalBudgetCents: number, now = Date.now(), opportunityId?: string) {
    if (!cents(proposalBudgetCents)) throw new Error("Invalid research proposal budget");
    if (opportunityId !== undefined && !id(opportunityId)) throw new Error("Invalid research scope");
    let remaining = proposalBudgetCents;
    const plans = [];
    for (const o of this.rank(now)) {
      if (opportunityId !== undefined && o.id !== opportunityId) continue;
      if (o.decision !== "validate" || o.proposedBudgetCents > remaining) continue;
      remaining -= o.proposedBudgetCents;
      const source=JSON.parse((this.db.prepare('SELECT payload FROM research_opportunities WHERE id=?').get(o.id) as {payload:string}).payload) as ResearchOpportunity;
      plans.push({ opportunityId: o.id, hypothesis: o.hypothesis, budgetCents: o.proposedBudgetCents,
        evidenceIds: o.sourceIds, action: "Prepare an offer draft and a manual demand-validation protocol",
        ...(source.economics?{economicAssessment:assessMarketingPlan(source.economics)}:{}),
        successCriteria: source.economics?.successCriterion??"Record at least 3 distinct qualified customer interviews and a verifiable paid pilot before any scale proposal",
        stopCondition: source.economics?.stopCriterion??"Stop at proposed budget or after 7 days without qualified demand; do not spend from this proposal",
        authorization: "draft-only; no outreach, publication, provider calls, payments or orders" });
    }
    return { mode: "offline-research", proposalBudgetCents, allocatedCents: proposalBudgetCents - remaining,
      assumptions: "Forecasts are supplied assumptions; evidence is operator-reviewed, not independently verified. No revenues booked.", plans };
  }
}
