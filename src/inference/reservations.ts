import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import {admitInferencePhase,bindInferencePhase,settleInferencePhase} from './phase-budget.js';

/** All unresolved calls count, even across clock windows or restarts. */
export function pendingInferenceCost(db: Database, scope: { sessionId?: string; experimentId?: string } = {}): number {
  const filters = ["status = 'pending'"];
  const args: string[] = [];
  if (scope.sessionId !== undefined) { filters.push("session_id = ?"); args.push(scope.sessionId); }
  if (scope.experimentId !== undefined) { filters.push("experiment_id = ?"); args.push(scope.experimentId); }
  // SQLite affinity does not guarantee integer values in an INTEGER column.
  // Validate every contributing row and the aggregate in the same read snapshot.
  try {
    const valid="typeof(reserved_cents) = 'integer' AND reserved_cents >= 0 AND reserved_cents <= 9007199254740991";
    const row=db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${valid} THEN reserved_cents ELSE 0 END),0) AS total,
      COALESCE(SUM(CASE WHEN ${valid} THEN 0 ELSE 1 END),0) AS invalid
      FROM inference_reservations WHERE ${filters.join(" AND ")}`).get(...args) as {total:number;invalid:number};
    if(row.invalid!==0||!Number.isSafeInteger(row.total)||row.total<0)throw Error();
    return row.total;
  } catch {
    throw new Error('Invalid pending inference accounting; reconciliation required');
  }
}

/** Caller must perform budget checks and this insert in one IMMEDIATE transaction. */
export function reserveInferenceCost(db: Database, sessionId: string, experimentId: string | undefined, model: string, cents: number,
  context?: { provider: string; turnId?: string; tier: string; taskType: string; requirePhase?:boolean }): string {
  if (!db.inTransaction) throw new Error("Inference reservation requires a transaction");
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid inference reservation amount");
  admitInferencePhase(db,cents,Date.now(),context?.requirePhase===true);
  const id = ulid();
  db.prepare("INSERT INTO inference_reservations (id, session_id, experiment_id, model, reserved_cents) VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionId, experimentId ?? null, model, cents);
  bindInferencePhase(db,id);
  if (context) db.prepare(`INSERT INTO inference_reservation_context(reservation_id,provider,turn_id,tier,task_type)
    VALUES(?,?,?,?,?)`).run(id, context.provider, context.turnId ?? null, context.tier, context.taskType);
  return id;
}

/** Atomic settlement: if recording fails, the reservation remains pending. */
export function settleInferenceCost(db: Database, id: string, record: () => void, actualCents?:number): void {
  db.transaction(() => {
    const result = db.prepare("UPDATE inference_reservations SET status = 'settled', settled_at = datetime('now') WHERE id = ? AND status = 'pending'").run(id);
    if (result.changes !== 1) throw new Error("Inference reservation is missing or already settled");
    record();
    settleInferencePhase(db,id,actualCents);
  }).immediate();
}
