import type { Database } from "better-sqlite3";
import { RevenueStore } from "./store.js";

export type AccountingMode = "expected" | "paper" | "unrealized" | "realized";
export const COST_CATEGORIES = ["ai_api","compute","hosting","data","infrastructure","external_service",
  "transaction","trading","funding","borrowing","slippage","experiment","acquisition","processing","refund","tax","other"] as const;
export interface ProfitEntry {
  id: string;
  mode: AccountingMode;
  kind: "revenue" | "expense";
  amountCents: number;
  category: typeof COST_CATEGORIES[number];
  opportunityId: string | null;
  experimentId: string | null;
  strategyId: string | null;
  businessId: string | null;
  productId: string | null;
  occurredAt: string;
}
const modes: AccountingMode[] = ["expected","paper","unrealized","realized"];
const identifier = (value: unknown) => value === null || typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function validate(entry: ProfitEntry) {
  if (!entry || !entry.id || !identifier(entry.id) || !modes.includes(entry.mode) || !["revenue","expense"].includes(entry.kind) ||
      !Number.isSafeInteger(entry.amountCents) || entry.amountCents < 0 || !COST_CATEGORIES.includes(entry.category) ||
      ![entry.opportunityId,entry.experimentId,entry.strategyId,entry.businessId,entry.productId].every(identifier) ||
      !Number.isFinite(Date.parse(entry.occurredAt))) throw new Error("Invalid structured profit entry");
}

/** Reuses economic_events and its idempotency/attribution checks. Entries are
 * accounting declarations: external payment authentication remains a separate
 * connector/reconciliation responsibility. No free-text or credentials field. */
export class ProfitLedger {
  constructor(private readonly db: Database) {}
  record(entry: ProfitEntry): string {
    validate(entry);
    const canonical: ProfitEntry = {id:entry.id,mode:entry.mode,kind:entry.kind,amountCents:entry.amountCents,
      category:entry.category,opportunityId:entry.opportunityId,experimentId:entry.experimentId,
      strategyId:entry.strategyId,businessId:entry.businessId,productId:entry.productId,
      occurredAt:new Date(entry.occurredAt).toISOString()};
    const eventType = entry.mode === "realized" ? entry.kind === "revenue" ? "payment" : "cost" : `${entry.mode}_${entry.kind}`;
    return new RevenueStore(this.db).addEconomicEvent({opportunityId:entry.opportunityId,experimentId:entry.experimentId,
      goalId:null,taskId:null,eventType,category:entry.category,amountCents:entry.amountCents,currency:"USD",
      channel:null,offer:null,customerRef:null,metadata:{profitLedger:canonical},occurredAt:canonical.occurredAt},`profit-ledger:${entry.id}`);
  }
  aggregate(options: { from?: number; to?: number; dimension?: "strategyId" | "opportunityId" | "businessId" | "productId" } = {}) {
    const from = options.from ?? 0, to = options.to ?? 8_640_000_000_000_000;
    if (![from,to].every(Number.isSafeInteger) || from < 0 || to <= from || options.dimension &&
        !["strategyId","opportunityId","businessId","productId"].includes(options.dimension)) throw new Error("Invalid ledger aggregation");
    return this.db.transaction(() => {
      const groups: Record<string,Record<AccountingMode,{revenueCents:number;expensesCents:number;netProfitCents:number}>> = Object.create(null);
      let legacyEntries = 0;
      for (const row of this.db.prepare("SELECT metadata_json,amount_cents,event_type,currency,opportunity_id,experiment_id FROM economic_events").iterate() as Iterable<{
        metadata_json:string;amount_cents:number;event_type:string;currency:string;opportunity_id:string|null;experiment_id:string|null;
      }>) {
        let entry: ProfitEntry | undefined;
        try { entry = JSON.parse(row.metadata_json).profitLedger; } catch { throw new Error("Malformed ledger metadata"); }
        if (!entry) {legacyEntries++;continue;}
        validate(entry);
        const expectedType = entry.mode === "realized" ? entry.kind === "revenue" ? "payment" : "cost" : `${entry.mode}_${entry.kind}`;
        if (row.currency !== "USD" || row.amount_cents !== entry.amountCents || row.event_type !== expectedType ||
            row.opportunity_id !== entry.opportunityId || row.experiment_id !== entry.experimentId) throw new Error("Ledger attribution mismatch");
        const time = Date.parse(entry.occurredAt);
        if (time < from || time >= to) continue;
        const key = options.dimension ? entry[options.dimension] ?? "unattributed" : "all";
        if (!groups[key]) groups[key] = Object.fromEntries(modes.map(mode => [mode,{revenueCents:0,expensesCents:0,netProfitCents:0}])) as typeof groups[string];
        const group = groups[key][entry.mode];
        if (entry.kind === "revenue") group.revenueCents += entry.amountCents;
        else group.expensesCents += entry.amountCents;
        group.netProfitCents = group.revenueCents - group.expensesCents;
        if (!Object.values(group).every(Number.isSafeInteger)) throw new Error("Unsafe ledger totals");
      }
      return {currency:"USD",groups,legacyEntries,verification:"accounting_declarations_not_external_authentication",
        limitation:"Inference accounting is separate and must be included once in total business economics. Mode labels alone do not authenticate revenue. No capital replenishment."};
    })();
  }
}
