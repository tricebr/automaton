import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { openOnline } from "../online/workspace.js";
import { OnlineRuntime } from "../online/runtime.js";
import {handoffResearchCandidate,planResearchExperiment,handoffResearchTask,claimResearchTask,configureResearchDispatch} from '../revenue/research-handoff.js';
import {initializeCapitalBudget} from '../revenue/capital-budget.js';
import {registerBudgetPolicy} from '../inference/budget-policy.js';
import {ExperimentBudgetGovernor} from '../revenue/budget-governor.js';
import { assertPublicEndpoint, publicJson, SOURCE_LIMITS } from "../online/sources.js";
import { createDatabase } from "../state/database.js";
import { openSimulation } from "../v1/simulation.js";
import { startOnlineDashboard } from "../online/dashboard.js";
import {ResearchDispatcher} from '../orchestration/research-dispatch.js';
import {researchSchedule} from '../online/scheduler.js';
import {HORIZON_TOPIC} from '../online/discovery.js';

let root: string, online: ReturnType<typeof openOnline>;
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function fixtureFetch() {
  return vi.fn<typeof fetch>(async (input, options) => {
    expect(options?.method).toBe("GET"); expect(options?.redirect).toBe("error"); expect(options?.credentials).toBe("omit");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    const url = String(input), time = Math.floor(Date.now() / 1000) - 60;
    if (url.includes("api.github.com")) return response({ incomplete_results: false, items: [{
      html_url: "https://github.com/example/project/issues/1", title: "Invoice automation needed", body: "Manual processing takes time",
      created_at: new Date(time * 1000).toISOString() }] });
    if (url.includes("askstories")) return response([12]);
    return response({ type: "story", time, title: "Ask HN: invoice workflow?", text: "<p>We need simpler invoice tools</p>" });
  });
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "aureus-online-")); online = openOnline({ directory: path.join(root, "run"), request: fixtureFetch() }); });
afterEach(() => { online.database.close(); fs.rmSync(root, { recursive: true, force: true }); });
const forecast = { revenueCents: 10000, costCents: 1000, probability: 0.5, days: 14, validationBudgetCents: 500 };

describe("online research runtime using exclusively mocked public sources", () => {
  it('discovers a new topic without founder seeds and does not revive cancelled legacy work', async () => {
    const db=online.database.raw,r=online.runtime;
    const legacy=r.enqueue('events');
    db.prepare("UPDATE online_jobs SET status='cancelled',error='Founder withdrew topic' WHERE id=?").run(legacy);
    expect(researchSchedule(db)).toMatchObject({topic:HORIZON_TOPIC,reason:'market_discovery'});
    r.configureAutonomy(true);r.control('start');
    await r.autonomousTick();
    expect(researchSchedule(db)).toMatchObject({topic:'invoice workflow',reason:'derived_hypothesis'});
    expect(db.prepare('SELECT status FROM online_jobs WHERE id=?').get(legacy)).toEqual({status:'cancelled'});
    expect(db.prepare('SELECT COUNT(*) n FROM revenue_experiments').get()).toEqual({n:0});
  });
  it('preserves queued work while the automatic source quota is exhausted',async()=>{
    const r=online.runtime,db=online.database.raw;
    r.enqueue('invoice automation');r.configureAutonomy(true);r.control('start');
    for(let i=0;i<SOURCE_LIMITS.hourlyRequests;i++)db.prepare("INSERT INTO online_requests(source,status) VALUES('fixture','received')").run();
    expect(await r.autonomousTick()).toBe(0);
    expect(db.prepare('SELECT status FROM online_jobs').get()).toEqual({status:'pending'});
    expect(db.prepare('SELECT COUNT(*) n FROM online_requests').get()).toEqual({n:SOURCE_LIMITS.hourlyRequests});
    db.exec("UPDATE online_requests SET created_at=datetime('now','-2 hours')");
    expect(await r.autonomousTick()).toBe(1);
    expect(db.prepare('SELECT status FROM online_jobs').get()).toEqual({status:'done'});
  });
  it('rechecks broad discovery after cooldown without retrying failures or assigning execution authority',async()=>{
    const db=online.database.raw,r=online.runtime;
    db.prepare("INSERT INTO online_jobs(topic,opportunity_id,status,created_at) VALUES(?,'fixture','done',datetime('now','-2 days'))").run(HORIZON_TOPIC);
    expect(researchSchedule(db)).toMatchObject({topic:HORIZON_TOPIC,revisit:true});
    r.configureAutonomy(true);r.control('start');
    expect(await r.autonomousTick()).toBe(1);
    expect(db.prepare('SELECT topic,status FROM online_jobs ORDER BY id DESC LIMIT 1').get()).toEqual({topic:HORIZON_TOPIC,status:'done'});
    expect(researchSchedule(db)).toMatchObject({topic:'invoice workflow',reason:'derived_hypothesis'});
    expect(db.prepare('SELECT COUNT(*) n FROM revenue_experiments').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) n FROM economic_events').get()).toEqual({n:0});
    db.prepare("INSERT INTO online_jobs(topic,opportunity_id,status) VALUES('invoice workflow','fixture','failed')").run();
    expect(researchSchedule(db).topic).toBeNull();
    db.exec("UPDATE online_jobs SET status='failed',created_at=datetime('now','-2 days')");
    expect(researchSchedule(db).topic).toBeNull();
    r.control('emergency');expect(await r.autonomousTick()).toBe(0);
  });
  it('shares derived selections across connections and preserves evidence after restart',async()=>{
    const db=online.database.raw,r=online.runtime;
    r.configureAutonomy(true);r.control('start');await r.autonomousTick();
    const original=r.research.evidence();
    const other=createDatabase(online.file),request=fixtureFetch();
    const second=new OnlineRuntime(other.raw,request);
    try{
      expect(second.snapshot().schedule).toMatchObject({topic:'invoice workflow',revisit:false});
      const results=await Promise.all([r.autonomousTick(),second.autonomousTick()]);
      expect(results.sort()).toEqual([0,1]);
      expect(db.prepare("SELECT COUNT(*) n FROM online_jobs WHERE topic='invoice workflow'").get()).toEqual({n:1});
      expect(request).not.toHaveBeenCalled();
      for(const item of original)expect(r.research.evidence()).toContainEqual(item);
      expect(researchSchedule(db).topic).toBeNull();
      second.recover();expect(second.status).toBe('paused');
      expect(await second.autonomousTick()).toBe(0);
    }finally{other.close();}
  });
  it('waits without new requests when broad discovery is cooling down and no hypothesis is eligible',async()=>{
    const db=online.database.raw;
    db.prepare("INSERT INTO online_jobs(topic,opportunity_id,status) VALUES(?,'fixture','done')").run(HORIZON_TOPIC);
    online.runtime.configureAutonomy(true);online.runtime.control('start');
    expect(await online.runtime.autonomousTick()).toBe(0);
    expect(online.runtime.snapshot().schedule).toMatchObject({reason:'cooldown_or_review',topic:null});
    expect(db.prepare('SELECT COUNT(*) n FROM online_requests').get()).toEqual({n:0});
  });
  it('hands off funded research once across connections and rechecks evidence after restart',async()=>{
    const r=online.runtime,db=online.database.raw;
    r.enqueue('invoice automation',forecast);r.control('start');await r.tick();
    const {evidence,research}=r.snapshot();
    for(const e of evidence)r.research.review(e.id,'fixture operator','accept','Fixture review');
    const {experimentId}=planResearchExperiment(db,research[0].id);
    db.exec("INSERT INTO goals(id,title,description,status,created_at) VALUES('g','Validation','fixture','active',datetime('now'))");
    expect(()=>handoffResearchTask(db,experimentId,'g')).toThrow('Already running');
    db.exec("UPDATE revenue_opportunities SET status='validating'; UPDATE revenue_experiments SET status='running',started_at=datetime('now'),max_budget_cents=100,max_inference_cost_cents=50");
    expect(()=>handoffResearchTask(db,experimentId,'g')).toThrow('shared spending');
    registerBudgetPolicy(db,{daily_cents:100,hourly_cents:100,session_cents:100,call_cents:10,halted:0,revision:1});
    expect(()=>handoffResearchTask(db,experimentId,'g')).toThrow('Capital policy');
    expect(db.prepare('SELECT COUNT(*) n FROM task_graph').get()).toEqual({n:0});
    initializeCapitalBudget(db,{capitalChfCents:1000,reserveChfCents:100,chfPerUsdNumerator:1,chfPerUsdDenominator:1,quoteExpiresAt:Date.now()+60000});
    const other=createDatabase(online.file);
    try{
      const first=handoffResearchTask(db,experimentId,'g');
      expect(handoffResearchTask(other.raw,experimentId,'g')).toEqual({...first,duplicate:true});
      expect(other.raw.prepare('SELECT status,max_retries,assigned_to FROM task_graph').get()).toEqual({status:'pending',max_retries:0,assigned_to:null});
      expect(other.raw.prepare('SELECT COUNT(*) n FROM task_graph').get()).toEqual({n:1});
      expect(other.raw.prepare('SELECT COUNT(*) n FROM inference_reservations').get()).toEqual({n:0});
      expect(()=>claimResearchTask(db,experimentId,'g','https://external.example')).toThrow('local worker');
      db.prepare('UPDATE task_graph SET dependencies=? WHERE id=?').run(JSON.stringify(['missing-prerequisite']),first.taskId);
      expect(()=>claimResearchTask(other.raw,experimentId,'g','local://one')).toThrow('not ready');
      expect(db.prepare('SELECT status,assigned_to FROM task_graph WHERE id=?').get(first.taskId)).toEqual({status:'pending',assigned_to:null});
      db.prepare("UPDATE task_graph SET dependencies='[]' WHERE id=?").run(first.taskId);
      expect(()=>claimResearchTask(other.raw,experimentId,'g','local://one')).toThrow('policy required');
      configureResearchDispatch(db,1);
      expect(claimResearchTask(other.raw,experimentId,'g','local://one')).toMatchObject({id:first.taskId,status:'assigned'});
      const restarted=createDatabase(online.file);
      try{
        expect(()=>claimResearchTask(restarted.raw,experimentId,'g','local://two')).toThrow('already claimed');
        expect(()=>claimResearchTask(restarted.raw,experimentId,'g','local://one')).toThrow('already claimed');
        expect(restarted.raw.prepare('SELECT assigned_to FROM task_graph WHERE id=?').get(first.taskId)).toEqual({assigned_to:'local://one'});
      }finally{restarted.close();}
      r.research.review(evidence[0].id,'fixture operator','reject','Withdrawn before dispatch');
      expect(()=>handoffResearchTask(other.raw,experimentId,'g')).toThrow('Research evidence');
      expect(new ExperimentBudgetGovernor(other.raw).checkInferenceBudget(experimentId,1).allowed).toBe(false);
    }finally{other.close();}
    const reopened=createDatabase(online.file);
    try{expect(()=>handoffResearchTask(reopened.raw,experimentId,'g')).toThrow('Research evidence');
      expect(reopened.raw.prepare('SELECT COUNT(*) n FROM task_graph').get()).toEqual({n:1});
    }finally{reopened.close();}
  });
  it("autonomously explores, drafts, persists and stops at quota without accepting demand", async () => {
    const r = online.runtime;
    r.configureAutonomy(true);
    expect(await r.autonomousTick()).toBe(0);
    r.control("start");
    expect(() => r.configureAutonomy(false)).toThrow();
    expect(await r.autonomousTick()).toBe(1);
    expect(await r.autonomousTick()).toBe(1);
    expect(await r.autonomousTick()).toBe(0);
    expect(r.snapshot().requests).toHaveLength(6);
    expect(r.snapshot().drafts).toHaveLength(1);
    expect(r.snapshot().research.every(o => o.independentSources === 0)).toBe(true);
    const second = new OnlineRuntime(online.database.raw, fixtureFetch());
    expect(second.autonomous).toBe(true);
    second.recover();
    expect(await second.autonomousTick()).toBe(0);
    expect(second.status).toBe("paused");
    second.control("emergency");
    expect(await second.autonomousTick()).toBe(0);
  });
  it("is stopped until explicitly started and never imports synthetic revenue", async () => {
    online.runtime.enqueue("invoice automation", forecast);
    expect(await online.runtime.tick()).toBe(0);
    online.runtime.control("start"); expect(await online.runtime.tick()).toBe(1);
    const snapshot = online.runtime.snapshot();
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.evidence.every(e => e.provenance === "reported" && e.reviewedBy === null)).toBe(true);
    expect(snapshot.research[0].decision).toBe("hold");
    expect(online.database.raw.prepare("SELECT COUNT(*) n FROM economic_events").get()).toEqual({ n: 0 });
    expect(snapshot.permissions).toMatchObject({ paidProviders: false, realOrders: false, publication: false });
    expect(snapshot.economicAgenda.actions.some(a=>a.action==='screen')).toBe(true);
    const handoff=handoffResearchCandidate(online.database.raw,snapshot.research[0].id);
    expect(handoff.duplicate).toBe(true);
    const other=createDatabase(online.file);
    try{expect(handoffResearchCandidate(other.raw,snapshot.research[0].id)).toEqual(handoff);}finally{other.close();}
    expect(online.database.raw.prepare('SELECT status,max_experiment_budget_cents,expected_revenue_cents FROM revenue_opportunities WHERE id=?').get(handoff.opportunityId)).toEqual({status:'screening',max_experiment_budget_cents:0,expected_revenue_cents:0});
    expect(online.database.raw.prepare('SELECT COUNT(*) n FROM revenue_experiments').get()).toEqual({n:0});
  });
  it("supports auditable manual acceptance/rejection and private drafts without execution", async () => {
    online.runtime.enqueue("invoice automation", forecast); online.runtime.control("start"); await online.runtime.tick();
    for (const e of online.runtime.snapshot().evidence) online.runtime.research.review(e.id, "test operator", "accept", "Fixture review only");
    const opportunity = online.runtime.snapshot().research[0];
    expect(opportunity.decision).toBe("validate");
    expect(online.runtime.draft(opportunity.id)).toMatchObject({ state: "private-draft", publication: "Not authorised or performed",
      validationPlan:{opportunityId:opportunity.id,budgetCents:500,authorization:expect.stringContaining('draft-only')},
      evidenceSnapshot:expect.arrayContaining([expect.objectContaining({digest:expect.stringMatching(/^[a-f0-9]{64}$/)})]) });
    const laterClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    try { online.runtime.draft(opportunity.id); }
    finally { laterClock.mockRestore(); }
    expect(online.runtime.snapshot().drafts).toHaveLength(1);
    const other=createDatabase(online.file);
    try {
      expect(planResearchExperiment(other.raw,opportunity.id).duplicate).toBe(true);
      expect(other.raw.prepare('SELECT status,max_budget_cents,max_inference_cost_cents,started_at FROM revenue_experiments').get()).toEqual({status:'planned',max_budget_cents:0,max_inference_cost_cents:0,started_at:null});
      expect(other.raw.prepare('SELECT forecast_cost_cents FROM revenue_experiments').get()).toEqual({forecast_cost_cents:1500});
    }finally{other.close();}
    online.runtime.research.review(online.runtime.snapshot().evidence[0].id, "test operator", "reject", "Not independent");
    expect(online.runtime.snapshot().research[0].decision).toBe("hold");
    expect(online.runtime.draft(opportunity.id).validationPlan).toBeNull();
    expect(online.runtime.snapshot().drafts).toHaveLength(2);
    expect(online.database.raw.prepare('SELECT COUNT(*) n FROM revenue_experiments').get()).toEqual({n:1});
    expect(()=>planResearchExperiment(online.database.raw,opportunity.id)).toThrow('reviewed demand');
    expect(online.database.raw.prepare('SELECT status,max_budget_cents FROM revenue_experiments').get()).toEqual({status:'planned',max_budget_cents:0});
  });
  it('blocks both inference and total admission when a source review is withdrawn across connections',async()=>{
    online.runtime.enqueue('invoice automation',forecast);online.runtime.control('start');await online.runtime.tick();
    const evidence=online.runtime.snapshot().evidence;
    for(const e of evidence)online.runtime.research.review(e.id,'fixture operator','accept','Fixture review');
    const id=online.runtime.snapshot().research[0].id;
    const {experimentId}=planResearchExperiment(online.database.raw,id);
    online.database.raw.exec("UPDATE revenue_opportunities SET status='validating'; UPDATE revenue_experiments SET status='running',started_at=datetime('now'),max_budget_cents=100,max_inference_cost_cents=50");
    const other=createDatabase(online.file);
    try {
      const governor=new ExperimentBudgetGovernor(other.raw);
      expect(governor.checkInferenceBudget(experimentId,1).allowed).toBe(true);
      expect(governor.checkTotalBudget(experimentId,1).allowed).toBe(true);
      online.runtime.research.review(evidence[0].id,'fixture operator','reject','Withdrawn fixture source');
      expect(governor.checkInferenceBudget(experimentId,1)).toMatchObject({allowed:false,reason:expect.stringContaining('Research evidence')});
      expect(governor.checkTotalBudget(experimentId,1).allowed).toBe(false);
      online.runtime.research.review(evidence[0].id,'fixture operator','accept','New review needs explicit plan revision');
      expect(governor.checkTotalBudget(experimentId,1).allowed).toBe(false);
      expect(other.raw.prepare('SELECT status FROM revenue_experiments WHERE id=?').get(experimentId)).toEqual({status:'running'});
    }finally{other.close();}
  });
  it('revises only unfunded unstarted plans and preserves immutable predecessor evidence',async()=>{
    online.runtime.enqueue('invoice automation',forecast);online.runtime.control('start');await online.runtime.tick();
    const evidence=online.runtime.snapshot().evidence,id=online.runtime.snapshot().research[0].id;
    for(const e of evidence)online.runtime.research.review(e.id,'fixture operator','accept','Fixture review');
    const original=planResearchExperiment(online.database.raw,id);
    online.runtime.research.review(evidence[0].id,'fixture operator','accept','New review');
    expect(()=>planResearchExperiment(online.database.raw,id)).toThrow('revision required');
    const other=createDatabase(online.file);
    try {
      const revised=planResearchExperiment(other.raw,id,'Reassessed source relevance');
      expect(revised.experimentId).not.toBe(original.experimentId);
      expect(planResearchExperiment(online.database.raw,id)).toEqual({...revised,duplicate:true});
      expect(other.raw.prepare('SELECT experiment_id FROM obolus_research_experiments').get()).toEqual({experiment_id:original.experimentId});
      expect(other.raw.prepare('SELECT previous_experiment_id FROM obolus_research_plan_revisions').get()).toEqual({previous_experiment_id:original.experimentId});
      const history=online.runtime.snapshot().validationPlans;
      expect(history.find(p=>p.experiment_id===original.experimentId)?.evidenceBlock).toContain('superseded');
      expect(history.find(p=>p.experiment_id===revised.experimentId)).toMatchObject({previous_experiment_id:original.experimentId,evidenceBlock:null});
      expect(other.raw.prepare('SELECT status,max_budget_cents,started_at FROM revenue_experiments WHERE id=?').get(revised.experimentId)).toEqual({status:'planned',max_budget_cents:0,started_at:null});
      other.raw.prepare('UPDATE revenue_experiments SET max_budget_cents=1 WHERE id=?').run(revised.experimentId);
      online.runtime.research.review(evidence[0].id,'fixture operator','accept','Another review');
      expect(()=>planResearchExperiment(other.raw,id,'May not reset funded work')).toThrow('unstarted, unfunded');
      expect(other.raw.prepare('SELECT COUNT(*) n FROM revenue_experiments').get()).toEqual({n:2});
      expect(()=>other.raw.exec('DELETE FROM obolus_research_plan_revisions')).toThrow('immutable');
    }finally{other.close();}
  });
  it('bounds revisions across connections while allowing idempotent reuse at the limit',async()=>{
    const r=online.runtime;
    r.enqueue('invoice automation',forecast);r.control('start');await r.tick();
    const {evidence,research}=r.snapshot(),id=research[0].id;
    for(const e of evidence)r.research.review(e.id,'fixture operator','accept','Fixture review');
    planResearchExperiment(online.database.raw,id);
    const other=createDatabase(online.file);
    try{
      for(let i=0;i<10;i++){
        r.research.review(evidence[0].id,'fixture operator','accept',`Review ${i}`);
        planResearchExperiment(i%2?other.raw:online.database.raw,id,`Revision ${i}`);
      }
      expect(planResearchExperiment(other.raw,id).duplicate).toBe(true);
      r.research.review(evidence[0].id,'fixture operator','accept','One more review');
      expect(()=>planResearchExperiment(other.raw,id,'Excess revision')).toThrow('revision limit');
      expect(other.raw.prepare('SELECT COUNT(*) n FROM revenue_experiments').get()).toEqual({n:11});
    }finally{other.close();}
  });
  it('requires paused revision and refuses replacement after even a zero-cost operation',async()=>{
    const r=online.runtime;
    r.enqueue('invoice automation',forecast);r.control('start');await r.tick();
    const {evidence,research}=r.snapshot(),id=research[0].id;
    for(const e of evidence)r.research.review(e.id,'fixture operator','accept','Fixture review');
    r.draft(id);
    r.research.review(evidence[0].id,'fixture operator','accept','Updated review');
    expect(()=>r.draft(id,'Reassess')).toThrow('Pause or stop');
    r.control('pause');
    expect(()=>r.draft(id,' ')).toThrow('bounded revision reason');
    const revised=r.draft(id,'Reassess');
    online.database.raw.exec('CREATE TABLE obolus_reserved_operations(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,actual_cost INTEGER)');
    online.database.raw.prepare('INSERT INTO obolus_reserved_operations VALUES(?,?,?,?)').run('fixture',JSON.stringify({experimentId:revised.plannedExperimentId}),'settled',0);
    r.research.review(evidence[0].id,'fixture operator','accept','Changed again');
    expect(()=>r.draft(id,'Cannot erase completed work')).toThrow('Existing operation requires review');
    expect(online.database.raw.prepare('SELECT COUNT(*) n FROM revenue_experiments').get()).toEqual({n:2});
  });
  it("limits requests across connections, including failed calls, before fetching", async () => {
    const other = createDatabase(online.file), controller = new AbortController();
    const failure = vi.fn<typeof fetch>(async () => { throw new Error("fixture failure"); });
    try {
      for (let i = 0; i < SOURCE_LIMITS.hourlyRequests; i++) {
        await expect(publicJson(i % 2 ? other.raw : online.database.raw, "https://hacker-news.firebaseio.com/v0/askstories.json", controller.signal, failure)).rejects.toThrow();
      }
      await expect(publicJson(other.raw, "https://hacker-news.firebaseio.com/v0/askstories.json", controller.signal, failure)).rejects.toThrow(/quota/);
      expect(failure).toHaveBeenCalledTimes(SOURCE_LIMITS.hourlyRequests);
    } finally { other.close(); }
  });
  it.each(["http://api.github.com/search/issues", "https://evil.example/search/issues", "https://api.github.com@127.0.0.1/search/issues",
    "https://api.github.com/repos/private", "https://hacker-news.firebaseio.com/v0/item/1.json?redirect=evil", "https://api.github.com/search/issues?token=secret"])("rejects unapproved endpoint %s", url => {
    expect(() => assertPublicEndpoint(url)).toThrow();
  });
  it("rejects oversized streamed responses and does not retry redirects", async () => {
    const mock = vi.fn<typeof fetch>(async () => new Response("x".repeat(SOURCE_LIMITS.responseBytes + 1)));
    await expect(publicJson(online.database.raw, "https://hacker-news.firebaseio.com/v0/askstories.json", new AbortController().signal, mock)).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
    const redirect = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }));
    await expect(publicJson(online.database.raw, "https://hacker-news.firebaseio.com/v0/askstories.json", new AbortController().signal, redirect)).rejects.toThrow();
    expect(redirect).toHaveBeenCalledTimes(1);
  });
  it("allows only one in-flight job across two worker connections", async () => {
    let release!: (value: Response) => void;
    const fixture = fixtureFetch(); let first = true;
    const mock = vi.fn<typeof fetch>((input, options) => {
      if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
      return fixture(input, options);
    });
    const other = createDatabase(online.file), worker = new OnlineRuntime(other.raw, mock);
    try {
      worker.enqueue("invoice automation", forecast); worker.enqueue("workflow automation", forecast); worker.control("start");
      const pending = worker.tick();
      expect(await online.runtime.tick()).toBe(0);
      release(response({ items: [], incomplete_results: false })); await pending;
    } finally { other.close(); }
  });
  it("stops a read from another connection and cannot ingest a late result", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const mock = vi.fn<typeof fetch>(async (_input, options) => {
      started(); return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const other = createDatabase(online.file), worker = new OnlineRuntime(other.raw, mock);
    try {
      worker.enqueue("invoice automation", forecast); worker.control("start"); const pending = worker.tick(); await ready;
      online.runtime.control("emergency"); await pending;
      expect(online.runtime.snapshot().evidence).toHaveLength(0);
      expect(online.runtime.snapshot().jobs[0]).toMatchObject({ status: "cancelled" });
      expect(online.runtime.status).toBe("emergency");
    } finally { other.close(); }
  });
  it("preserves quotas across restart and requires explicit resume", () => {
    online.runtime.enqueue("invoice automation", forecast); online.runtime.control("start");
    online.database.raw.prepare("INSERT INTO online_requests(source,status) VALUES('api.github.com','reserved')").run();
    online.database.raw.prepare("UPDATE online_jobs SET status='running'").run();
    online.database.close(); online = openOnline({ resume: online.file, request: fixtureFetch() });
    expect(online.runtime.status).toBe("paused");
    expect(online.runtime.snapshot().jobs[0]).toMatchObject({ status: "cancelled" });
    expect(online.runtime.snapshot().requests).toHaveLength(1);
  });
  it("refuses simulation databases and existing new-workspace directories", () => {
    expect(() => openOnline({ directory: path.join(root, "run") })).toThrow();
    const simulation = openSimulation(undefined, undefined, path.join(root, "simulation"));
    try { expect(() => openOnline({ resume: simulation.file })).toThrow(); }
    finally { simulation.database.close(); }
  });
  it("rejects topic operators and duplicate queues", () => {
    expect(() => online.runtime.enqueue("token:secret")).toThrow();
    online.runtime.enqueue("invoice automation");
    expect(() => online.runtime.enqueue("invoice automation")).toThrow(/already/);
  });
});

describe("online control surface", () => {
  it('keeps autonomous quota waits running while still pausing an empty manual run',async()=>{
    const db=online.database.raw,r=online.runtime;
    for(let i=0;i<SOURCE_LIMITS.hourlyRequests;i++)db.prepare("INSERT INTO online_requests(source,status) VALUES('fixture','received')").run();
    r.configureAutonomy(true);r.control('start');
    const tick=vi.spyOn(r,'autonomousTick');
    const ui=await startOnlineDashboard(r);
    try{
      await vi.waitFor(()=>expect(tick).toHaveBeenCalled(),{timeout:3000});
      expect(r.status).toBe('running');
      expect(r.snapshot().schedule.reason).toBe('source_quota');
      expect(db.prepare('SELECT COUNT(*) n FROM online_jobs').get()).toEqual({n:0});
      r.control('pause');r.configureAutonomy(false);r.control('resume');
      await vi.waitFor(()=>expect(r.status).toBe('paused'),{timeout:3000});
    }finally{await ui.close();tick.mockRestore();}
  });
  it("has valid browser script, authenticated controls, bounded requests and no live-money route", async () => {
    const ui = await startOnlineDashboard(online.runtime);
    let token = "";
    function call(route: string, body?: unknown, headers: Record<string,string> = {}) {
      return new Promise<{ status: number; text: string; csp?: string }>((resolve, reject) => {
        const req = http.request(ui.url + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Aureus-Token": token, ...headers } }, res => {
          let text = ""; res.on("data", chunk => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode!, text, csp: res.headers["content-security-policy"] as string }));
        }); req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
      });
    }
    try {
      const page = await call("/"); token = /const AUTH="([a-f0-9]+)"/.exec(page.text)![1];
      expect(page.text).toContain('<h1>numaron</h1>');
      expect((await call("/api/snapshot", undefined, { "X-Obolus-Token": token, "X-Aureus-Token": "" })).status).toBe(200);
      expect((await call("/api/snapshot", undefined, { "X-Obolus-Token": "invalid" })).status).toBe(403);
      expect(page.csp).toContain("frame-ancestors 'none'");
      expect(() => new vm.Script(/<script[^>]*>([\s\S]*?)<\/script>/.exec(page.text)![1])).not.toThrow();
      expect((await call("/api/control", { action: "start" }, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await call("/api/snapshot", undefined, { Host: "evil.example" })).status).toBe(403);
      expect((await call("/api/snapshot", undefined, { "X-Aureus-Token": "" })).status).toBe(403);
      expect((await call("/api/queue", { topic: "x".repeat(9000) })).status).toBe(413);
      expect((await call("/api/order", { symbol: "BTC" })).status).toBe(404);
      expect((await call('/api/dispatch-stop',{state:'emergency'})).status).toBe(400);
      const pool={spawn:vi.fn(),shutdown:vi.fn(async()=>{})};
      const dispatcher=new ResearchDispatcher(online.database.raw,pool);
      await dispatcher.control('running');
      expect((await call('/api/dispatch-stop',{state:'paused'},{Origin:'https://evil.example'})).status).toBe(403);
      expect(dispatcher.state).toBe('running');
      expect((await call('/api/dispatch-stop',{state:'paused'})).status).toBe(200);
      expect(dispatcher.state).toBe('paused');
      expect((await call('/api/dispatch-stop',{state:'running'})).status).toBe(400);
      expect((await call('/api/dispatch-stop',{state:'stopped'})).status).toBe(200);
      expect((await call('/api/dispatch-stop',{state:'emergency'})).status).toBe(200);
      expect((await call('/api/dispatch-stop',{state:'stopped'})).status).toBe(400);
      expect(dispatcher.state).toBe('emergency');
      expect(pool.spawn).not.toHaveBeenCalled();
      expect(online.database.raw.prepare('SELECT COUNT(*) n FROM obolus_dispatch_control_audit').get()).toEqual({n:3});
      for (const action of ["start", "pause", "resume", "stop", "emergency", "reset"]) expect((await call("/api/control", { action })).status).toBe(200);
      expect(online.runtime.status).toBe("stopped");
    } finally { await ui.close(); }
  });
});
