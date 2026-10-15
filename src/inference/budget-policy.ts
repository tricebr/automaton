import type { Database } from "better-sqlite3";
import type { ModelStrategyConfig } from "../types.js";

export interface SharedBudgetPolicy {
  daily_cents: number | null; hourly_cents: number | null;
  session_cents: number | null; call_cents: number | null;
  halted: number; revision: number;
}
const fields = ["daily_cents", "hourly_cents", "session_cents", "call_cents"] as const;
function validPolicy(policy:SharedBudgetPolicy):boolean {
  return !!policy&&fields.every(key=>policy[key]===null||(Number.isSafeInteger(policy[key])&&policy[key]!>=0))&&
    [0,1].includes(policy.halted)&&Number.isSafeInteger(policy.revision)&&policy.revision>=1;
}
export function policyFromConfig(config: ModelStrategyConfig, daily?: number): SharedBudgetPolicy {
  const amounts = [config.hourlyBudgetCents, config.sessionBudgetCents, config.perCallCeilingCents];
  if (![...amounts, ...(daily === undefined ? [] : [daily])].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error("Invalid inference budget limits");
  }
  // Preserve legacy strategy-zero semantics; an explicit treasury zero is a stop.
  return { daily_cents: daily ?? null, hourly_cents: amounts[0] || null,
    session_cents: amounts[1] || null, call_cents: amounts[2] || null, halted: 0, revision: 1 };
}
export function readBudgetPolicy(db: Database): SharedBudgetPolicy | undefined {
  const policy=db.prepare("SELECT * FROM inference_budget_policy WHERE id=1").get() as SharedBudgetPolicy | undefined;
  if(policy&&!validPolicy(policy))throw new Error('Invalid stored shared budget policy; reconciliation required');
  return policy;
}
/** Workers may only tighten shared limits. Never lift a limit on restart/config drift. */
export function registerBudgetPolicy(db: Database, requested: SharedBudgetPolicy): SharedBudgetPolicy {
  if(!validPolicy(requested))throw new Error('Invalid shared budget policy');
  return db.transaction(() => {
    const previous = readBudgetPolicy(db);
    const next = { ...requested };
    if (previous) {
      for (const key of fields) {
        const a = previous[key], b = requested[key];
        next[key] = a === null ? b : b === null ? a : Math.min(a, b);
      }
      next.halted = previous.halted === 1 || requested.halted === 1 ? 1 : 0;
      if (fields.every(key => next[key] === previous[key]) && next.halted === previous.halted) return previous;
      next.revision = previous.revision + 1;
    }
    db.prepare(`INSERT INTO inference_budget_policy(id,daily_cents,hourly_cents,session_cents,call_cents,halted,revision)
      VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET daily_cents=excluded.daily_cents,
      hourly_cents=excluded.hourly_cents,session_cents=excluded.session_cents,call_cents=excluded.call_cents,
      halted=excluded.halted,revision=excluded.revision`).run(...fields.map(key => next[key]), next.halted, next.revision);
    db.prepare("INSERT INTO inference_budget_audit(action,detail) VALUES('tighten',?)").run(JSON.stringify({ previous, next }));
    return next;
  }).immediate();
}
export function haltInferenceBudget(db: Database, reason: string): void {
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO inference_budget_policy(id,halted) VALUES(1,1)").run();
    db.prepare("UPDATE inference_budget_policy SET halted=1,revision=revision+1 WHERE id=1").run();
    db.prepare("INSERT INTO inference_budget_audit(action,detail) VALUES('halt',?)").run(JSON.stringify({ reason }));
  }).immediate();
}
