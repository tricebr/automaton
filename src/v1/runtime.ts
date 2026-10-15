import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import { RevenueStore } from "../revenue/store.js";
import { SIMULATION_SCHEMA } from "./schema.js";
import { currentPolicy, policyScore } from "./policy.js";
import { ResearchStore } from "../revenue/research.js";

export const STAGES = ["discover", "validate", "launch", "measure", "monetize", "improve", "scale"] as const;
export type Stage = typeof STAGES[number];
export const SECTORS = ["software", "saas", "ai-automation", "digital-products", "b2b-services", "data-products", "marketplaces", "market-research"] as const;
export interface Settings { capitalCents: number; liquidityFloorCents: number; spendLimitCents: number; perTaskCents: number; workers: number; maxActiveCases?: number }
export const DEFAULT_SETTINGS: Settings = { capitalCents: 100000, liquidityFloorCents: 50000, spendLimitCents: 20000, perTaskCents: 100, workers: 2 };
export interface Receipt { costCents: number; revenueCents: number; qualifiedLeads: number; paidCustomers: number; evidenceRef: string; note: string }
export interface Candidate {
  name: string; sector: typeof SECTORS[number]; source: string; hypothesis: string;
  maxCostCents: number; forecastNetCents: number; minLeads: number; minCustomers: number; minNetCents: number;
  /** Synthetic fixtures are explicit data, never claimed to be customer evidence. */
  scenario: Record<Stage, Receipt>;
}
interface CaseRow { id: string; stage: string; scenario: string; max_cost_cents: number; min_leads: number; min_customers: number; min_net_cents: number; forecast_net_cents: number }
export interface Job { id: string; case_id: string; experiment_id: string; stage: Stage; status: string; worker: string | null; token: string | null; reserved_cents: number; receipt: string | null }
type Status = "stopped" | "running" | "paused" | "emergency";
const cents = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000;
function validateReceipt(r: Receipt): void {
  if (!r || ![r.costCents, r.revenueCents, r.qualifiedLeads, r.paidCustomers].every(cents) ||
      typeof r.evidenceRef !== "string" || !r.evidenceRef.startsWith("simulation:") || r.evidenceRef.length > 500 ||
      typeof r.note !== "string" || r.note.length > 2000) throw new Error("Invalid simulation receipt");
}

export class SimulationRuntime {
  readonly revenue: RevenueStore;
  readonly research: ResearchStore;
  constructor(readonly db: Database, settings: Settings = DEFAULT_SETTINGS) {
    if (![settings.capitalCents, settings.liquidityFloorCents, settings.spendLimitCents, settings.perTaskCents].every(cents) ||
        settings.capitalCents <= 0 || settings.perTaskCents <= 0 || settings.liquidityFloorCents > settings.capitalCents ||
        !Number.isInteger(settings.workers) || settings.workers < 1 || settings.workers > 8 ||
        settings.maxActiveCases!==undefined&&(!Number.isInteger(settings.maxActiveCases)||settings.maxActiveCases<1||settings.maxActiveCases>500)) throw new Error("Invalid simulation limits");
    this.revenue = new RevenueStore(db);
    this.research = new ResearchStore(db);
    db.exec(SIMULATION_SCHEMA);
    db.prepare("INSERT OR IGNORE INTO v1_control(id,mode,status,settings) VALUES(1,'simulation','stopped',?)").run(JSON.stringify(settings));
  }
  get settings(): Settings { return JSON.parse((this.db.prepare("SELECT settings FROM v1_control WHERE id=1").get() as { settings: string }).settings); }
  get status(): Status { return (this.db.prepare("SELECT status FROM v1_control WHERE id=1").get() as { status: Status }).status; }
  private audit(action: string, detail: unknown): void {
    this.db.prepare("INSERT INTO v1_audit(action,detail) VALUES(?,?)").run(action, JSON.stringify(detail));
  }
  control(action: "start" | "pause" | "resume" | "stop" | "emergency" | "reset"): void {
    this.db.transaction(() => {
      const status = this.status;
      const allowed: Record<string, Status[]> = { start: ["stopped"], pause: ["running"], resume: ["paused"],
        stop: ["running", "paused", "stopped"], emergency: ["running", "paused", "stopped", "emergency"], reset: ["emergency"] };
      if (!allowed[action]?.includes(status)) throw new Error(`Invalid control transition: ${status}/${action}`);
      const next = { start: "running", resume: "running", pause: "paused", stop: "stopped", emergency: "emergency", reset: "stopped" }[action];
      this.db.prepare("UPDATE v1_control SET status=?,revision=revision+1 WHERE id=1").run(next);
      if (action === "stop" || action === "emergency") this.db.prepare("UPDATE v1_jobs SET status='uncertain' WHERE status='running'").run();
      this.audit("control", { action, previous: status, next });
    }).immediate();
  }
  /** Call once on controller boot, not for every worker connection. */
  recover(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE v1_control SET status='paused',revision=revision+1 WHERE id=1 AND status='running'").run();
      const lost = this.db.prepare("UPDATE v1_jobs SET status='uncertain' WHERE status='running'").run().changes;
      this.audit("recovery", { uncertainJobs: lost, status: this.status });
    }).immediate();
  }
  discover(input: Candidate): string {
    if (!input.name.trim() || input.name.length > 200 || !input.hypothesis.trim() || input.hypothesis.length > 2000 ||
        !input.source.startsWith("simulation:") || !SECTORS.includes(input.sector) ||
        ![input.maxCostCents, input.minLeads, input.minCustomers, input.minNetCents].every(cents) ||
        !Number.isSafeInteger(input.forecastNetCents) || Math.abs(input.forecastNetCents) > 100_000_000) throw new Error("Invalid simulated candidate");
    STAGES.forEach(stage => validateReceipt(input.scenario[stage]));
    return this.db.transaction(() => {
      if ((this.db.prepare("SELECT count(*) n FROM v1_cases").get() as { n: number }).n >= 500) throw new Error("Simulation case capacity reached");
      const id = this.revenue.createOpportunity({ goalId: null, name: input.name, niche: input.sector, status: "validating",
        evidenceLevel: "synthetic", confidence: 0.5, probabilitySuccess: 0.5, expectedRevenueCents: Math.max(0, input.forecastNetCents + input.maxCostCents),
        expectedCostCents: input.maxCostCents, expectedNetValueCents: input.forecastNetCents, timeToRevenueDays: 7,
        maxExperimentBudgetCents: input.maxCostCents, focusRank: null, hypothesis: input.hypothesis,
        killCondition: "Stop on failed measurable criteria, cost ceiling, or missing evidence", nextAction: "discover" });
      this.db.prepare(`INSERT INTO v1_cases(id,stage,sector,source,scenario,max_cost_cents,min_leads,min_customers,min_net_cents,forecast_net_cents)
        VALUES(?,'discover',?,?,?,?,?,?,?,?)`).run(id, input.sector, input.source, JSON.stringify(input.scenario), input.maxCostCents,
          input.minLeads, input.minCustomers, input.minNetCents, input.forecastNetCents);
      this.enqueue(id, "discover"); this.audit("discover", { caseId: id, source: input.source, mode: "simulation" });
      return id;
    }).immediate();
  }
  private enqueue(caseId: string, stage: Stage): void {
    const c = this.getCase(caseId);
    const id = this.revenue.createExperiment({ opportunityId: caseId, goalId: null, taskId: null, status: "planned",
      hypothesis: this.revenue.getOpportunity(caseId)!.hypothesis!, channel: "simulation", offer: stage,
      maxBudgetCents: this.settings.perTaskCents, maxInferenceCostCents: 0, maxDurationHours: 24,
      successCriteria: JSON.stringify({ minLeads: c.min_leads, minCustomers: c.min_customers, minNetCents: c.min_net_cents }),
      failureCriteria: "Criteria missed or missing attributable evidence", stopCondition: "Budget or operator stop",
      forecastRevenueCents: 0, forecastCostCents: this.settings.perTaskCents, forecastProbabilitySuccess: 0.5,
      forecastTimeToRevenueHours: 24, actualRevenueCents: 0, actualCostCents: 0, result: null, lesson: null, startedAt: null, completedAt: null });
    this.db.prepare("INSERT INTO v1_jobs(id,case_id,experiment_id,stage,status) VALUES(?,?,?,?,'pending')").run(ulid(), caseId, id, stage);
  }
  private getCase(id: string): CaseRow {
    const row = this.db.prepare("SELECT * FROM v1_cases WHERE id=?").get(id) as CaseRow | undefined;
    if (!row) throw new Error("Unknown simulation case"); return row;
  }
  totals(): { spentCents: number; revenueCents: number; reservedCents: number; netCents: number; liquidCents: number } {
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN event_type='cost' THEN amount_cents ELSE 0 END),0) spent,
      COALESCE(SUM(CASE WHEN event_type='payment' THEN amount_cents ELSE 0 END),0) revenue
      FROM economic_events WHERE opportunity_id IN (SELECT id FROM v1_cases)`).get() as { spent: number; revenue: number };
    const held = (this.db.prepare("SELECT COALESCE(SUM(reserved_cents),0) n FROM v1_jobs WHERE status IN ('running','uncertain')").get() as { n: number }).n;
    return { spentCents: row.spent, revenueCents: row.revenue, reservedCents: held, netCents: row.revenue - row.spent,
      liquidCents: this.settings.capitalCents + row.revenue - row.spent - held };
  }
  claim(worker: string): Job | null {
    if (!worker.trim() || worker.length > 100) throw new Error("Invalid worker");
    return this.db.transaction(() => {
      if (this.status !== "running") return null;
      const running = (this.db.prepare("SELECT count(*) n FROM v1_jobs WHERE status='running'").get() as { n: number }).n;
      if (running >= this.settings.workers || this.db.prepare("SELECT 1 FROM v1_jobs WHERE status='running' AND worker=?").get(worker)) return null;
      const jobs = this.db.prepare("SELECT * FROM v1_jobs WHERE status='pending' ORDER BY id LIMIT 500").all() as Job[];
      // Forecast score plus recorded synthetic evidence; no external demand claim.
      jobs.sort((a, b) => this.priority(b.case_id) - this.priority(a.case_id) || a.id.localeCompare(b.id));
      const totals = this.totals(); const reserved = this.settings.perTaskCents;
      if (totals.spentCents + totals.reservedCents + reserved > this.settings.spendLimitCents ||
          totals.liquidCents - reserved < this.settings.liquidityFloorCents) return null;
      for (const job of jobs) {
        const c = this.getCase(job.case_id);
        // A funded case keeps its slot until terminal, including uncertain work after a crash.
        // This opt-in simulation policy limits fragmentation, never increases spending limits.
        const activeLimit=this.settings.maxActiveCases;
        if(activeLimit!==undefined) {
          const active=this.db.prepare(`SELECT c.id FROM v1_cases c WHERE c.stage NOT IN ('completed','stopped')
            AND EXISTS(SELECT 1 FROM v1_jobs j WHERE j.case_id=c.id AND j.status IN ('running','uncertain','done'))`).all() as {id:string}[];
          if(!active.some(row=>row.id===c.id)&&active.length>=activeLimit)continue;
        }
        const economics = this.revenue.getOpportunityEconomics(job.case_id);
        const held = (this.db.prepare("SELECT COALESCE(SUM(reserved_cents),0) n FROM v1_jobs WHERE case_id=? AND status IN ('running','uncertain')").get(c.id) as { n: number }).n;
        if (economics.costCents + held + reserved > c.max_cost_cents) {
          this.stopCase(c.id, "Case cost ceiling reached before next experiment"); continue;
        }
        const token = ulid();
        this.db.prepare("UPDATE v1_jobs SET status='running',worker=?,token=?,reserved_cents=? WHERE id=? AND status='pending'").run(worker, token, reserved, job.id);
        this.revenue.transitionExperimentStatus(job.experiment_id, "running");
        this.audit("claim", { jobId: job.id, worker, reservedCents: reserved });
        return { ...job, status: "running", worker, token, reserved_cents: reserved };
      }
      return null;
    }).immediate();
  }
  private priority(caseId: string): number {
    const o = this.revenue.getOpportunity(caseId)!;
    const economics = this.revenue.getOpportunityEconomics(caseId);
    return policyScore(currentPolicy(this.db), this.revenue.getOpportunityPriorityScore(o),
      Math.min(3, economics.paymentCount || 0), o.maxExperimentBudgetCents / 1000, o.timeToRevenueDays ?? 7);
  }
  private stopCase(id: string, reason: string): void {
    this.db.prepare("UPDATE v1_cases SET stage='stopped',lesson=? WHERE id=?").run(reason, id);
    const pending = this.db.prepare("SELECT experiment_id FROM v1_jobs WHERE case_id=? AND status='pending'").all(id) as { experiment_id: string }[];
    for (const job of pending) this.revenue.transitionExperimentStatus(job.experiment_id, "stopped", reason, reason);
    this.db.prepare("UPDATE v1_jobs SET status='failed' WHERE case_id=? AND status='pending'").run(id);
    this.revenue.updateOpportunity(id, { status: "kill", nextAction: reason }); this.audit("stop_case", { caseId: id, reason });
  }
  uncertain(jobId: string, token: string, reason: string): void {
    this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE v1_jobs SET status='uncertain' WHERE id=? AND token=? AND status='running'").run(jobId, token).changes;
      if (changed) this.audit("uncertain", { jobId, reason: reason.slice(0, 500) });
    }).immediate();
  }
  /** Pure fixture executor: never imports agent tools, providers, shell or wallets. */
  simulate(job: Job): Receipt {
    return structuredClone((JSON.parse(this.getCase(job.case_id).scenario) as Candidate["scenario"])[job.stage]);
  }
  settle(jobId: string, token: string, receipt: Receipt, reconciliation = false): void {
    validateReceipt(receipt);
    this.db.transaction(() => {
      const job = this.db.prepare("SELECT * FROM v1_jobs WHERE id=?").get(jobId) as Job | undefined;
      if (!job || job.token !== token) throw new Error("Stale or unknown worker receipt");
      if (job.status === "done") {
        if (job.receipt !== JSON.stringify(receipt)) throw new Error("Conflicting duplicate receipt"); return;
      }
      if (job.status !== "running" && !(reconciliation && job.status === "uncertain")) throw new Error("Explicit reconciliation required");
      if (receipt.costCents > job.reserved_cents) throw new Error("Simulation result exceeds its authorised cost");
      const event = { opportunityId: job.case_id, experimentId: job.experiment_id, goalId: null, taskId: null,
        category: "simulation", currency: "USD", channel: "simulation", offer: job.stage, customerRef: null,
        metadata: { mode: "simulation", source: receipt.evidenceRef, jobId }, occurredAt: new Date().toISOString() };
      this.revenue.addEconomicEvent({ ...event, eventType: "cost", amountCents: receipt.costCents }, `v1:${job.id}:cost`);
      if (receipt.revenueCents) this.revenue.addEconomicEvent({ ...event, eventType: "payment", amountCents: receipt.revenueCents }, `v1:${job.id}:revenue`);
      this.db.prepare("UPDATE v1_jobs SET status='done',receipt=?,reserved_cents=0 WHERE id=?").run(JSON.stringify(receipt), job.id);
      this.revenue.transitionExperimentStatus(job.experiment_id, "completed", receipt.note, `Evidence: ${receipt.evidenceRef} (synthetic)`);
      const c = this.getCase(job.case_id); const economics = this.revenue.getOpportunityEconomics(c.id);
      let reason = "";
      if (job.stage === "validate" && receipt.qualifiedLeads < c.min_leads) reason = "Validation demand criterion missed";
      if ((job.stage === "monetize" || job.stage === "scale") &&
          (receipt.paidCustomers < c.min_customers || economics.netProfitCents < c.min_net_cents)) reason = "Paid demand or net return criterion missed";
      if (reason) this.stopCase(c.id, reason);
      else {
        const next: Stage | "completed" = job.stage === "scale" ? "completed" : STAGES[STAGES.indexOf(job.stage) + 1];
        const lesson = `Forecast net ${c.forecast_net_cents}c; observed synthetic net ${economics.netProfitCents}c; error ${economics.netProfitCents - c.forecast_net_cents}c`;
        this.db.prepare("UPDATE v1_cases SET stage=?,lesson=? WHERE id=?").run(next, lesson, c.id);
        this.revenue.updateOpportunity(c.id, { status: next === "completed" ? "completed" : next === "scale" ? "scale" : "active", nextAction: next });
        if (next !== "completed") this.enqueue(c.id, next);
      }
      this.audit(reconciliation ? "reconcile" : "settle", { jobId, receipt, nextStage: this.getCase(c.id).stage });
    }).immediate();
  }
  reconcileSimulatedJobs(): number {
    if (this.status === "running") throw new Error("Pause before reconciliation");
    const jobs = this.db.prepare("SELECT * FROM v1_jobs WHERE status='uncertain'").all() as Job[];
    for (const job of jobs) this.settle(job.id, job.token!, this.simulate(job), true);
    return jobs.length;
  }
  async tick(): Promise<number> {
    const jobs: Job[] = [];
    for (let i = 0; i < this.settings.workers; i++) { const job = this.claim(`simulation-worker-${i + 1}`); if (job) jobs.push(job); }
    await Promise.all(jobs.map(async job => {
      await Promise.resolve();
      try { this.settle(job.id, job.token!, this.simulate(job)); }
      catch (error) { this.uncertain(job.id, job.token!, error instanceof Error ? error.message : "Simulation failure"); }
    }));
    return jobs.length;
  }
  snapshot() {
    return {
      mode: "simulation" as const, status: this.status, settings: this.settings, totals: this.totals(),
      goals: ["Validate legitimate demand", "Protect liquidity", "Measure net results before scaling"],
      cases: this.db.prepare(`SELECT c.id,o.name,c.sector,c.stage,c.source,c.max_cost_cents,c.forecast_net_cents,c.lesson
        FROM v1_cases c JOIN revenue_opportunities o ON o.id=c.id ORDER BY c.rowid DESC LIMIT 100`).all(),
      jobs: this.db.prepare("SELECT id,case_id,experiment_id,stage,status,worker,reserved_cents,receipt FROM v1_jobs ORDER BY rowid DESC LIMIT 100").all(),
      experiments: this.db.prepare(`SELECT id,opportunity_id,status,offer,hypothesis,max_budget_cents,success_criteria,result,lesson
        FROM revenue_experiments WHERE opportunity_id IN (SELECT id FROM v1_cases) ORDER BY rowid DESC LIMIT 100`).all(),
      audit: this.db.prepare("SELECT * FROM v1_audit ORDER BY id DESC LIMIT 100").all(),
      paper: this.db.prepare("SELECT * FROM v1_paper ORDER BY rowid DESC LIMIT 10").all(),
      policies: this.db.prepare("SELECT * FROM v1_policy_versions ORDER BY id DESC LIMIT 20").all(),
      research: this.research.rank(),
      approvals: { liveExecution: "disabled", realOrders: "not implemented", paidProviders: "disabled", shell: "disabled", codeSelfModification: "disabled" },
      models: [{ id: "deterministic-fixture", provider: "local-simulation", inputTokens: 0, outputTokens: 0, realCostCents: 0 }],
    };
  }
}
