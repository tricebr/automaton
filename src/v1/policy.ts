import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";

/** Only ranking data may evolve. No source code, budgets, permissions or Genesis. */
export interface RankingPolicy { evidenceWeight: number; capitalWeight: number; timeWeight: number }
export const DEFAULT_POLICY: RankingPolicy = { evidenceWeight: 1, capitalWeight: 1, timeWeight: 1 };
export function policyScore(p: RankingPolicy, net: number, demand: number, capital: number, time: number): number {
  return net * (1 + p.evidenceWeight * Math.max(0, demand)) /
    ((1 + p.capitalWeight * Math.max(0, capital)) * Math.pow(Math.max(1, time), p.timeWeight));
}
export function currentPolicy(db: Database): RankingPolicy {
  const row = db.prepare("SELECT payload FROM v1_policy_versions WHERE active=1").get() as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) : { ...DEFAULT_POLICY };
}
function validate(p: RankingPolicy): void {
  const keys = ["capitalWeight", "evidenceWeight", "timeWeight"];
  if (!p || JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(keys) ||
      !Object.values(p).every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 2)) {
    throw new Error("Only bounded ranking weights may change; safety rules are immutable");
  }
}
export interface PolicyEvidence { baselineTrain: number; candidateTrain: number; baselineOos: number; candidateOos: number; source: string }
/** Isolated worker evaluates fixed code with numeric data, never evals agent code. */
export async function assessPolicy(baseline: RankingPolicy, candidate: RankingPolicy): Promise<PolicyEvidence> {
  validate(baseline); validate(candidate);
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    const score = ${policyScore.toString()};
    function evaluate(p,start){let total=0;for(let i=start;i<start+20;i++){
      const factor=1+i/100;
      const choices=[{net:2000*factor,demand:0,capital:3,time:1,outcome:-100},
        {net:200*factor,demand:3,capital:1,time:1,outcome:200}];
      choices.sort((a,b)=>score(p,b.net,b.demand,b.capital,b.time)-score(p,a.net,a.demand,a.capital,a.time));
      total+=choices[0].outcome;}return total;}
    parentPort.postMessage({baselineTrain:evaluate(workerData.baseline,0),candidateTrain:evaluate(workerData.candidate,0),
      baselineOos:evaluate(workerData.baseline,100),candidateOos:evaluate(workerData.candidate,100),source:'synthetic-ranking-fixture-v1'});`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { baseline, candidate },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Isolated policy validation timed out")); }, 5000);
    worker.once("message", data => { clearTimeout(timer); resolve(data); void worker.terminate(); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => { clearTimeout(timer); if (code !== 0) reject(new Error("Policy validation worker exited")); });
  });
}
export async function activatePolicy(db: Database, candidate: RankingPolicy): Promise<number> {
  validate(candidate);
  const baseline = currentPolicy(db);
  const evidence = await assessPolicy(baseline, candidate);
  if (evidence.candidateTrain <= evidence.baselineTrain || evidence.candidateOos <= evidence.baselineOos) {
    throw new Error("No measured training and held-out improvement; policy unchanged");
  }
  return db.transaction(() => {
    if (JSON.stringify(currentPolicy(db)) !== JSON.stringify(baseline)) throw new Error("Policy changed during isolated validation");
    const put = (p: RankingPolicy, validation: unknown, active: number) => {
      const payload = JSON.stringify(p); return Number(db.prepare("INSERT INTO v1_policy_versions(payload,digest,validation,active) VALUES(?,?,?,?)")
        .run(payload, createHash("sha256").update(payload).digest("hex"), JSON.stringify(validation), active).lastInsertRowid);
    };
    if (!db.prepare("SELECT 1 FROM v1_policy_versions").get()) put(baseline, { source: "initial-default" }, 0);
    db.prepare("UPDATE v1_policy_versions SET active=0").run();
    const id = put(candidate, evidence, 1);
    db.prepare("INSERT INTO v1_audit(action,detail) VALUES('policy_activate',?)").run(JSON.stringify({ version: id, evidence }));
    return id;
  }).immediate();
}
export function rollbackPolicy(db: Database, version: number): void {
  db.transaction(() => {
    const row = db.prepare("SELECT payload,digest FROM v1_policy_versions WHERE id=?").get(version) as { payload: string; digest: string } | undefined;
    if (!row || createHash("sha256").update(row.payload).digest("hex") !== row.digest) throw new Error("Unknown or corrupted policy version");
    validate(JSON.parse(row.payload));
    db.prepare("UPDATE v1_policy_versions SET active=0").run();
    db.prepare("UPDATE v1_policy_versions SET active=1 WHERE id=?").run(version);
    db.prepare("INSERT INTO v1_audit(action,detail) VALUES('policy_rollback',?)").run(JSON.stringify({ version }));
  }).immediate();
}
