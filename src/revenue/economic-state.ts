import type { Database } from "better-sqlite3";
import { checkCapitalBudget } from "./capital-budget.js";
import { pendingInferenceCost } from "../inference/reservations.js";
import { ProfitLedger } from "./profit-ledger.js";
import {reconciledProfitEvidence,profitReconciliationBlocked} from './profit-reconciliation.js';
import {activeLiveOrderPredicate} from './live-settlement.js';

const safe = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Economic state requires accounting reconciliation");
  return n;
};
export interface EconomicTotals { revenueCents: number; expensesCents: number; netProfitCents: number }
const empty = (): EconomicTotals => ({ revenueCents: 0, expensesCents: 0, netProfitCents: 0 });

/** A read-only projection of existing ledgers, never a second cash ledger.
 * Legacy events are claims, not authenticated realized profit. Forecasts and
 * paper portfolios remain separate. Unknown capital is null, never free money. */
export function economicState(db: Database, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid economic state timestamp");
  return db.transaction(() => {
    const recorded = empty();
    const byOpportunity: Record<string, EconomicTotals> = Object.create(null);
    const costsByCategory: Record<string, number> = Object.create(null);
    const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    let burn30DaysCents = 0, unclassifiedEvents = 0;
    const since = now - 30 * 86400000;
    const add = (scope: EconomicTotals, revenue: number, cost: number) => {
      scope.revenueCents = safe(scope.revenueCents + revenue);
      scope.expensesCents = safe(scope.expensesCents + cost);
      scope.netProfitCents = scope.revenueCents - scope.expensesCents;
    };
    const rows = db.prepare("SELECT opportunity_id,event_type,category,amount_cents,currency,occurred_at FROM economic_events").iterate() as Iterable<{
      opportunity_id: string | null; event_type: string; category: string | null; amount_cents: number; currency: string; occurred_at: string;
    }>;
    for (const row of rows) {
      safe(row.amount_cents);
      if (row.currency !== "USD") throw new Error("Economic state requires explicit currency conversion");
      const revenue = ["payment", "renewal", "expansion"].includes(row.event_type) ? row.amount_cents : 0;
      const cost = ["cost", "refund"].includes(row.event_type) ? row.amount_cents : 0;
      if (!revenue && !cost) unclassifiedEvents++;
      add(recorded, revenue, cost);
      const key = row.opportunity_id ?? "unattributed";
      add(byOpportunity[key] ??= empty(), revenue, cost);
      if (cost) {
        const category = row.category ?? "unclassified";
        costsByCategory[category] = safe((costsByCategory[category] ?? 0) + cost);
        const time = Date.parse(row.occurred_at);
        if (!Number.isFinite(time) || time > now) throw new Error("Invalid economic event timestamp");
        if (time >= since) burn30DaysCents = safe(burn30DaysCents + cost);
      }
    }
    let apiCostCents = 0;
    for (const row of db.prepare(`SELECT i.cost_cents,i.created_at,e.opportunity_id
      FROM inference_costs i LEFT JOIN revenue_experiments e ON e.id=i.experiment_id`).iterate() as Iterable<{
      cost_cents: number; created_at: string; opportunity_id: string | null;
    }>) {
      apiCostCents = safe(apiCostCents + safe(row.cost_cents));
      add(recorded, 0, row.cost_cents);
      add(byOpportunity[row.opportunity_id ?? "unattributed"] ??= empty(), 0, row.cost_cents);
      const time = Date.parse(row.created_at.includes("T") ? row.created_at : row.created_at.replace(" ", "T") + "Z");
      if (!Number.isFinite(time) || time > now) throw new Error("Invalid inference accounting timestamp");
      if (time >= since) burn30DaysCents = safe(burn30DaysCents + row.cost_cents);
    }
    const reservedInferenceCents = pendingInferenceCost(db);
    const liveOrderExposure = exists("obolus_live_order_holds") ? db.prepare(`SELECT COUNT(*) AS unresolvedOrders,
      COALESCE(SUM(usd_cents),0) AS reservedUsdCents,COALESCE(SUM(risk_cents),0) AS plannedRiskUsdCents
      FROM obolus_live_order_holds WHERE ${activeLiveOrderPredicate(db)}`).get() as {unresolvedOrders:number;reservedUsdCents:number;plannedRiskUsdCents:number} : null;
    if(liveOrderExposure)Object.values(liveOrderExposure).forEach(safe);
    const configuredCapital = exists("aureus_capital_policy");
    const capital = configuredCapital ? checkCapitalBudget(db, 0) : null;
    let paperPortfolio: null | {currency:string;closedProfitCents:number;unrealizedPnlCents:number|null;drawdownCents:number|null;marksCurrent:boolean} = null;
    if(exists("paper_portfolio_control")) {
      const control=db.prepare("SELECT limits,closed_equity_cents,peak_cents,clock FROM paper_portfolio_control WHERE id=1").get() as
        {limits:string;closed_equity_cents:number;peak_cents:number;clock:number}|undefined;
      if(control){
        const limits=JSON.parse(control.limits) as {currency?:string;initialCapitalCents:number};
        [limits.initialCapitalCents,control.closed_equity_cents,control.peak_cents,control.clock].forEach(safe);
        const open=(db.prepare("SELECT COUNT(*) n FROM paper_portfolio_positions WHERE status='open'").get() as {n:number}).n;
        const marks=db.prepare("SELECT m.at,m.pnl_cents FROM paper_portfolio_marks m JOIN paper_portfolio_positions p ON p.id=m.id WHERE p.status='open'").all() as {at:number;pnl_cents:number}[];
        if(marks.some(mark=>!Number.isSafeInteger(mark.at)||!Number.isSafeInteger(mark.pnl_cents)))throw new Error("Invalid paper marks");
        const current=marks.length===open&&marks.every(mark=>mark.at===control.clock);
        const unrealized=current?marks.reduce((sum,mark)=>sum+mark.pnl_cents,0):null;
        if(unrealized!==null&&!Number.isSafeInteger(unrealized))throw new Error("Unsafe paper valuation");
        const peak=(db.prepare("SELECT peak_cents FROM paper_portfolio_valuation WHERE id=1").get() as {peak_cents:number}|undefined)?.peak_cents??control.peak_cents;
        safe(peak);
        paperPortfolio={currency:limits.currency??"USD",closedProfitCents:control.closed_equity_cents-limits.initialCapitalCents,
          unrealizedPnlCents:unrealized,drawdownCents:unrealized===null?null:Math.max(0,peak-control.closed_equity_cents-unrealized),marksCurrent:current};
      }
    }
    const attributedOpportunities=exists('obolus_profit_statements')?(db.prepare(`SELECT DISTINCT e.opportunity_id FROM obolus_profit_statements s
      JOIN revenue_experiments e ON e.id=s.experiment_id ORDER BY e.opportunity_id LIMIT 101`).all() as {opportunity_id:string}[]):[];
    const attribution=attributedOpportunities.slice(0,100).map(row=>({
      opportunityId:row.opportunity_id,blocked:profitReconciliationBlocked(db,row.opportunity_id),evidence:reconciledProfitEvidence(db,row.opportunity_id),
      coverage:'Closed attributed experiments only. Not a complete enterprise balance sheet; paper remains paper.'
    }));
    const contributions=(['live','paper'] as const).map(mode=>{
      const groups=attribution.map(a=>{
        const evidence=a.evidence.filter(e=>e.mode===mode&&e.reconciled);
        const revenueCents=evidence.reduce((s,e)=>s+e.revenueCents,0),costCents=evidence.reduce((s,e)=>s+e.costCents,0);
        safe(revenueCents);safe(costCents);
        return {opportunityId:a.opportunityId,samples:evidence.length,blocked:a.blocked,revenueCents,costCents,netCents:revenueCents-costCents};
      }).filter(g=>g.samples>0);
      const positive=groups.reduce((s,g)=>s+Math.max(0,g.netCents),0),loss=groups.reduce((s,g)=>s+Math.max(0,-g.netCents),0);
      safe(positive);safe(loss);
      return {mode,positiveNetCents:positive,lossCents:loss,
        winners:groups.filter(g=>g.netCents>0).sort((a,b)=>b.netCents-a.netCents).map(g=>({...g,shareOfPositiveNet:g.netCents/positive})),
        losers:groups.filter(g=>g.netCents<0).sort((a,b)=>a.netCents-b.netCents).map(g=>({...g,shareOfLoss:-g.netCents/loss})),
        limitation:'Observed scoped contributors, no assumed 80/20 split, causal attribution or promise of future marginal returns. Capital allocation still requires current evidence and hard admission.'};
    });
    return {
      version: 1, asOf: now, currency: "USD", recordedClaims: recorded,
      reconciledAttributionTruncated:attributedOpportunities.length>100,
      reconciledAttribution:attribution,profitContributors:contributions,
      classifiedAccounting: new ProfitLedger(db).aggregate({to:now+1}),
      realizedNetProfitCents: null, unrealizedPnlCents: null, paperProfitCents: null,
      expectedProfitCents: null, apiCostCents, costsByCategory, byOpportunity,
      burn30DaysCents, averageDailyBurnCents: Math.ceil(burn30DaysCents / 30),
      reservedInferenceCents, availableCapitalChfCents: capital?.remainingChfCents ?? null,
      liveOrderExposure,
      paperPortfolio,
      capitalAdmission: capital ?? { allowed: false, reason: "Explicit capital policy is missing" },
      unclassifiedEvents, executionAuthorized: false,
      limitation: "Recorded claims include legacy/test entries and are not authenticated realized profit. Inference costs are added once from their ledger. Unrecorded expenses, taxes and liabilities remain unknown. Paper, expected and unrealized results require separate attributed valuation. CHF capital is never replenished by revenue claims.",
    };
  })();
}
