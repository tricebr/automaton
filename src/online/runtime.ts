import {bountyLearning} from '../revenue/bounty-learning.js';
import {runSourceSearch,searchConnectorSnapshot} from './search-runner.js';
import type {SearchTask} from './search-adapters.js';
import type {SearchTransport} from './search-transport.js';
import {planSourceSearches,sourceScoutSnapshot} from './source-scout.js';
import {buildBountyShadowDraft,type BountyDraft} from '../revenue/bounty-shadow.js';
import {bountySnapshot,runBountyOfflineCheck,type BountyPlan} from '../revenue/bug-bounty.js';
import { createHash } from "node:crypto";
import {handoffResearchCandidate,planResearchExperiment,researchPlanHistory} from '../revenue/research-handoff.js';
import {economicMissionAgenda} from '../revenue/mission.js';
import {researchDispatchSnapshot,restrictResearchDispatch} from '../orchestration/research-dispatch.js';
import type { Database } from "better-sqlite3";
import { ResearchStore, type ResearchOpportunity } from "../revenue/research.js";
import { discoverPublicSignals, validateTopic, SOURCE_LIMITS, type PublicFetch } from "./sources.js";
import {researchSchedule} from './scheduler.js';
import {improvementResearchSchedule,improvementTopic} from '../revenue/proactive-research.js';
import {inferencePhaseSnapshot} from '../inference/phase-budget.js';
import {collectReviewedShadowSources} from './shadow-sources.js';
import {collectReviewedDiverseSources,hasSourceDiversity,sourceDiversityMetrics} from './source-diversity.js';
import {DISCOVERY_SCHEMA,HORIZON_TOPIC,recordDiscoverySignals,recordDiscoveryTrial,discoveryCandidates,inspectDiscoveryTrialEvidence} from './discovery.js';

export const ONLINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS online_control(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL CHECK(mode='online-research'),
  status TEXT NOT NULL CHECK(status IN ('stopped','running','paused','emergency')),revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS online_jobs(id INTEGER PRIMARY KEY,topic TEXT NOT NULL,opportunity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','done','cancelled','failed')),revision INTEGER,
  result_count INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS online_requests(id INTEGER PRIMARY KEY,source TEXT NOT NULL,status TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE INDEX IF NOT EXISTS online_requests_created ON online_requests(created_at);
CREATE TABLE IF NOT EXISTS online_audit(id INTEGER PRIMARY KEY,action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS online_drafts(id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS online_autonomy(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO online_autonomy(id,enabled) VALUES(1,0);
`;
type Status = "stopped" | "running" | "paused" | "emergency";
export class OnlineRuntime {
  readonly research: ResearchStore;
  private active = new Set<AbortController>();
  constructor(readonly db: Database, private readonly request?: PublicFetch) {
    db.exec(ONLINE_SCHEMA);
    db.exec(DISCOVERY_SCHEMA);
    db.prepare("INSERT OR IGNORE INTO online_control(id,mode,status) VALUES(1,'online-research','stopped')").run();
    this.research = new ResearchStore(db);
  }
  get status(): Status { return (this.db.prepare("SELECT status FROM online_control WHERE id=1").get() as { status: Status }).status; }
  restrictDispatch(state:'paused'|'stopped'|'emergency') { return restrictResearchDispatch(this.db,state); }
  private audit(action: string, detail: unknown) { this.db.prepare("INSERT INTO online_audit(action,detail) VALUES(?,?)").run(action, JSON.stringify(detail)); }
  configureAutonomy(enabled: boolean) {
    if (typeof enabled !== "boolean") throw new Error("Invalid autonomy setting");
    this.db.transaction(() => {
      if (this.status === "running" || this.status === "emergency") throw new Error("Pause or stop before changing autonomy");
      this.db.prepare("UPDATE online_autonomy SET enabled=? WHERE id=1").run(Number(enabled));
      this.audit("autonomy", { enabled, scope: "public research and private drafts only" });
    }).immediate();
  }
  get autonomous(): boolean { return !!(this.db.prepare("SELECT enabled FROM online_autonomy WHERE id=1").get() as { enabled: number }).enabled; }
  /** Bounded exploration: never interpret source text as instructions or fabricate economics. */
  async autonomousTick(): Promise<number> {
    if (!this.autonomous || this.status !== "running") return this.tick();
    const ready=this.db.transaction(() => {
      if (this.status !== "running") return false;
      planSourceSearches(this.db);
      // Exploit economically supported opportunities first; unsupported ones are research only.
      for (const item of this.research.rank()) {
        if (item.title!==HORIZON_TOPIC && !improvementTopic(item.title) && this.discoveryEvidenceUsable(item.id) && this.research.evidence(item.id).length && !this.db.prepare("SELECT 1 FROM online_drafts WHERE opportunity_id=?").get(item.id)) this.draft(item.id);
      }
      const primary=researchSchedule(this.db);
      const schedule=primary.reason==='cooldown_or_review'?improvementResearchSchedule(this.db):primary;
      if(schedule.topic){this.enqueue(schedule.topic);this.audit('autonomous_selection',{
        topic:schedule.topic,reason:schedule.reason,revisit:schedule.revisit,profitability:'unknown',maxRequests:5});}
      return !!schedule.topic||schedule.reason==='queued_work';
    }).immediate();
    return ready?this.tick():0;
  }
  recover() {
    this.db.transaction(() => {
      this.db.prepare("UPDATE online_control SET status='paused',revision=revision+1 WHERE status='running'").run();
      this.db.prepare("UPDATE online_jobs SET status='cancelled',error='Controller restarted; no automatic retry' WHERE status='running'").run();
      this.audit("recover", { status: this.status });
    }).immediate();
  }
  control(action: "start" | "pause" | "resume" | "stop" | "emergency" | "reset") {
    this.db.transaction(() => {
      const allowed: Record<string, Status[]> = { start: ["stopped"], resume: ["paused"], pause: ["running"],
        stop: ["running", "paused", "stopped"], emergency: ["stopped", "running", "paused", "emergency"], reset: ["emergency"] };
      if (!allowed[action]?.includes(this.status)) throw new Error("Invalid online control transition");
      const next = { start: "running", resume: "running", pause: "paused", stop: "stopped", emergency: "emergency", reset: "stopped" }[action];
      this.db.prepare("UPDATE online_control SET status=?,revision=revision+1 WHERE id=1").run(next);
      if (["pause", "stop", "emergency"].includes(action)) {
        this.db.prepare("UPDATE online_jobs SET status='cancelled',error='Cancelled by operator' WHERE status='running'").run();
      }
      this.audit("control", { action, next });
    }).immediate();
    if (["pause", "stop", "emergency"].includes(action)) for (const active of this.active) active.abort();
  }
  enqueue(topicInput: string, suppliedForecast?: ResearchOpportunity["forecast"]) {
    const forecast=suppliedForecast??{revenueCents:0,costCents:0,probability:0,days:30,validationBudgetCents:0};
    const topic = validateTopic(topicInput);
    return this.db.transaction(() => {
      if (this.status === "emergency") throw new Error("Reset emergency before queuing work");
      if ((this.db.prepare("SELECT COUNT(*) n FROM online_jobs WHERE status IN ('pending','running')").get() as { n: number }).n >= 10) throw new Error("Online queue capacity reached");
      if (this.db.prepare("SELECT 1 FROM online_jobs WHERE topic=? AND created_at >= datetime('now','-1 hour')").get(topic)) throw new Error("Topic already queued within the last hour");
      const opportunityId = `online-${createHash("sha256").update(topic.toLowerCase()+JSON.stringify(forecast)+(!suppliedForecast?':unknown':'')).digest("hex").slice(0,24)}`;
      const candidate=discoveryCandidates(this.db).find(c=>c.topic===topic);
      // Reusing a historical topic must not rewrite its immutable classification.
      const existing=this.db.prepare('SELECT payload FROM research_opportunities WHERE id=?').get(opportunityId) as {payload:string}|undefined;
      const method=improvementTopic(topic);
      const sector:ResearchOpportunity['sector']=existing?JSON.parse(existing.payload).sector:(method?'market-research':candidate?.sector??'software');
      this.research.import({ opportunities: [existing?JSON.parse(existing.payload):{ id: opportunityId, title: topic, sector,
        hypothesis: method?`${method.question} Acceptance: ${method.check} Public sources are unverified method indicators, not demand or authority.`:`Investigate reported needs for ${topic}; no verified willingness to pay`, forecast,
        ...(!suppliedForecast?{forecastState:'unknown' as const}:{})}], evidence: [] });
      const id = Number(this.db.prepare("INSERT INTO online_jobs(topic,opportunity_id,status) VALUES(?,?,'pending')").run(topic, opportunityId).lastInsertRowid);
      this.audit("enqueue", { id, topic }); return id;
    }).immediate();
  }
  async tick(): Promise<number> {
    const job = this.db.transaction(() => {
      const control = this.db.prepare("SELECT status,revision FROM online_control WHERE id=1").get() as { status: Status; revision: number };
      if (control.status !== "running" || this.db.prepare("SELECT 1 FROM online_jobs WHERE status='running'").get()) return null;
      const next = this.db.prepare("SELECT id,topic,opportunity_id FROM online_jobs WHERE status='pending' ORDER BY id LIMIT 1").get() as { id: number; topic: string; opportunity_id: string } | undefined;
      if (!next) return null;
      // Recheck persisted evidence at the claim boundary, not just when queued.
      // Expired but internally consistent evidence may support bounded revalidation.
      const prior=this.db.prepare('SELECT job_id FROM online_discovery_trials WHERE topic=? ORDER BY job_id DESC LIMIT 1').get(next.topic) as {job_id:number}|undefined;
      if(prior&&!inspectDiscoveryTrialEvidence(this.db,prior.job_id).verified){
        this.db.prepare("UPDATE online_jobs SET status='failed',error='Discovery evidence reconciliation required before source access' WHERE id=? AND status='pending'").run(next.id);
        this.audit('admission_blocked',{jobId:next.id,reason:'discovery_evidence'});
        return null;
      }
      this.db.prepare("UPDATE online_jobs SET status='running',revision=? WHERE id=?").run(control.revision, next.id);
      return { ...next, revision: control.revision };
    }).immediate();
    if (!job) return 0;
    const controller = new AbortController(); this.active.add(controller);
    // Other controller connections must be able to stop a pending network read.
    const watcher = setInterval(() => {
      const state = this.db.prepare("SELECT status,revision FROM online_control WHERE id=1").get() as { status: string; revision: number };
      if (state.status !== "running" || state.revision !== job.revision) controller.abort();
    }, 100);
    try {
      const revalidation=!!this.db.prepare('SELECT 1 FROM online_discovery_trials WHERE topic=? LIMIT 1').get(job.topic);
      // An explicitly provisioned bounded phase must never use the legacy
      // unreviewed transport. Incomplete phase state throws rather than falling back.
      const phase=inferencePhaseSnapshot(this.db);
      const diverse=hasSourceDiversity(this.db);
      if(diverse&&!phase)throw Error('Diverse source phase missing');
      const signals = phase
        ? diverse&&job.topic===HORIZON_TOPIC
          ? (await collectReviewedDiverseSources(this.db,job.topic,controller.signal,this.request)).signals
              .filter(s=>s.observedAt&&(s.kind==='problem_report'||s.kind==='procurement_notice'))
              .map(s=>({id:s.id,sourceUrl:s.sourceUrl,observedAt:s.observedAt!,title:s.title,excerpt:s.excerpt}))
          : (await collectReviewedShadowSources(this.db,job.topic,job.topic===HORIZON_TOPIC,controller.signal,this.request)).sources
        : await discoverPublicSignals(this.db, job.topic, controller.signal, this.request, job.topic===HORIZON_TOPIC,revalidation);
      this.db.transaction(() => {
        const current = this.db.prepare("SELECT status,revision FROM online_control WHERE id=1").get() as { status: string; revision: number };
        const status = (this.db.prepare("SELECT status FROM online_jobs WHERE id=?").get(job.id) as { status: string }).status;
        if (controller.signal.aborted || current.status !== "running" || current.revision !== job.revision || status !== "running") return;
        this.research.import({ opportunities: [], evidence: signals.map(s => ({ ...s,
          id: `${s.id}-${createHash('sha256').update(JSON.stringify([s.excerpt,job.opportunity_id,s.observedAt])).digest('hex').slice(0,12)}`,
          opportunityId: job.opportunity_id, kind: improvementTopic(job.topic)?"method":"request", provenance: "reported", reviewedBy: null })) });
        if(!improvementTopic(job.topic))recordDiscoverySignals(this.db,signals);
        if(job.topic!==HORIZON_TOPIC&&!improvementTopic(job.topic))recordDiscoveryTrial(this.db,job.id,job.topic,signals);
        if(this.db.prepare('SELECT 1 FROM online_discovery_trials WHERE job_id=?').get(job.id)&&!inspectDiscoveryTrialEvidence(this.db,job.id).verified)
          throw new Error('Discovery evidence reconciliation required');
        this.db.prepare("UPDATE online_jobs SET status='done',result_count=? WHERE id=?").run(signals.length, job.id);
        if(signals.length&&job.topic!==HORIZON_TOPIC&&!improvementTopic(job.topic))handoffResearchCandidate(this.db,job.opportunity_id);
        this.audit("discovered", { jobId: job.id, count: signals.length, purpose:improvementTopic(job.topic)?'method-research':'market-research',reviewRequired: true });
      }).immediate();
    } catch {
      this.db.prepare("UPDATE online_jobs SET status='failed',error='Public read failed or cancelled; inspect quota and source availability' WHERE id=? AND status='running'").run(job.id);
      this.audit("read_failure", { jobId: job.id });
    } finally { clearInterval(watcher); this.active.delete(controller); }
    return 1;
  }
  private discoveryEvidenceUsable(opportunityId:string):boolean {
    const trial=this.db.prepare(`SELECT t.job_id,v.expires_ms FROM online_discovery_trials t
      JOIN online_jobs j ON j.id=t.job_id LEFT JOIN online_discovery_trial_validity v ON v.job_id=t.job_id
      WHERE j.opportunity_id=? ORDER BY t.job_id DESC LIMIT 1`).get(opportunityId) as {job_id:number;expires_ms:number|null}|undefined;
    return !trial||(Number.isSafeInteger(trial.expires_ms)&&trial.expires_ms!>=Date.now()&&inspectDiscoveryTrialEvidence(this.db,trial.job_id).verified);
  }
  draft(opportunityId: string,revisionReason?:string) {
    return this.db.transaction(() => {
    if(!this.discoveryEvidenceUsable(opportunityId))throw new Error('Current discovery evidence reconciliation required before drafting');
    if(revisionReason!==undefined&&(!['paused','stopped'].includes(this.status)||typeof revisionReason!=='string'||!revisionReason.trim()||revisionReason.length>1000))
      throw new Error('Pause or stop and provide a bounded revision reason');
    const item = this.research.rank().find(o => o.id === opportunityId);
    if (!item) throw new Error("Unknown opportunity");
    if(improvementTopic(item.title))throw new Error('Method research requires an optimization or domain-specific validation trial, not a customer offer draft');
    const evidence = this.research.evidence(opportunityId);
    if (!evidence.length) throw new Error("Collect source material before creating a draft");
    const economicBrief = this.research.economicBrief(opportunityId);
    // Reassess on every call, but do not make the wall clock part of content
    // identity. Evidence dates, review states and expired/changed assessments
    // remain in the snapshot; draft/audit creation times are stored separately.
    const {assessedAt:_assessmentTime, ...marketDecision} = economicBrief.marketDecision;
    const payload = JSON.stringify({ title: item.title, hypothesis: item.hypothesis, state: "private-draft",
      economicBrief:{...economicBrief,marketDecision},
      evidenceIds: evidence.map(e=>e.id), reviewState: item.decision,
      plannedExperimentId: item.decision==='validate'?planResearchExperiment(this.db,opportunityId,revisionReason).experimentId:null,
      evidenceSnapshot: evidence.map(e=>({id:e.id,digest:e.digest})),
      validationPlan: this.research.plan(item.proposedBudgetCents, Date.now(), opportunityId).plans[0] ?? null,
      planValidity: "Historical draft only; recheck current evidence reviews and all admission limits before execution",
      offer: `Draft pilot: assess a narrowly scoped ${item.title} workflow with a prospective customer.`,
      scope: "Document one repeated workflow, measure current effort and agree a small reversible pilot.",
      price: "Not set: validate willingness to pay and delivery costs first",
      validation: "Three distinct qualified customer interviews; one independently verifiable paid pilot before a scale proposal",
      publication: "Not authorised or performed", claims: "No claimed savings, existing customers or revenue" });
    const digest = createHash("sha256").update(payload).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO online_drafts(id,opportunity_id,payload,digest) VALUES(?,?,?,?)").run(digest, opportunityId, payload, digest);
    this.audit("private_draft", { opportunityId, digest }); return JSON.parse(payload);
    }).immediate();
  }
  draftBountyReport(input:BountyDraft) { return buildBountyShadowDraft(this.db,input); }
  searchSources(id:string,task:SearchTask,transport?:SearchTransport) {
    return runSourceSearch(this.db,id,task,transport);
  }
  checkBountyArtifact(jobId:string,plan:BountyPlan,artifact:Parameters<typeof runBountyOfflineCheck>[3]) {
    return runBountyOfflineCheck(this.db,jobId,plan,artifact);
  }
  snapshot() {
    return { mode: "online-research", status: this.status, autonomous: this.autonomous, limits: SOURCE_LIMITS,schedule:researchSchedule(this.db),
      proactiveResearch:improvementResearchSchedule(this.db),
      bugBounty:{...bountySnapshot(this.db),learning:bountyLearning(this.db)},
      sourceDiversity:hasSourceDiversity(this.db)?sourceDiversityMetrics(this.db):null,
      sourceScout:sourceScoutSnapshot(this.db),
      searchConnectors:searchConnectorSnapshot(this.db),
      permissions: { publicReads: true, paidProviders: false, publication: false, outreach: false, realOrders: false, shell: false },
      research: this.research.rank(), discovery:discoveryCandidates(this.db), evidence: this.research.evidence(),economicAgenda:economicMissionAgenda(this.db),
      validationPlans:researchPlanHistory(this.db),
      discoveryAudits:(this.db.prepare('SELECT job_id FROM online_discovery_trials ORDER BY job_id DESC LIMIT 100').all() as {job_id:number}[])
        .map(row=>({jobId:row.job_id,...inspectDiscoveryTrialEvidence(this.db,row.job_id)})),
      dispatch:researchDispatchSnapshot(this.db),
      jobs: this.db.prepare("SELECT * FROM online_jobs ORDER BY id DESC LIMIT 100").all(),
      requests: this.db.prepare("SELECT * FROM online_requests ORDER BY id DESC LIMIT 100").all(),
      drafts: this.db.prepare("SELECT * FROM online_drafts ORDER BY created_at DESC LIMIT 50").all(),
      audit: this.db.prepare("SELECT * FROM online_audit ORDER BY id DESC LIMIT 100").all() };
  }
}
