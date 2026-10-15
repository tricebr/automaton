import type BetterSqlite3 from "better-sqlite3";
import { RevenueStore, validateEconomicNumbers } from "./store.js";
import { inferenceGetExperimentCost } from "../state/database.js";
import { pendingInferenceCost } from "../inference/reservations.js";
import {pendingOperationCost} from './pending-operations.js';
import {researchAdmissionBlock} from './research-admission.js';
import {opportunityDemandEvidence} from './outcome.js';
import {revalidationAdmission} from './revalidation.js';
import {profitReconciliationBlocked,reconciledProfitEvidence} from './profit-reconciliation.js';
import {profitabilityAdmission} from './profitability.js';

type Database = BetterSqlite3.Database;

export interface ExperimentInferenceBudgetCheck {
  allowed: boolean;
  experimentId: string;
  currentInferenceCostCents: number;
  estimatedAdditionalCostCents: number;
  limitCents: number;
  remainingCents: number | null;
  reason?: string;
}

export interface ExperimentTotalBudgetCheck {
  allowed: boolean;
  experimentId: string;
  economicCostCents: number;
  inferenceCostCents: number;
  currentTotalCostCents: number;
  estimatedAdditionalCostCents: number;
  limitCents: number;
  remainingCents: number | null;
  reason?: string;
}

export interface ExperimentDurationCheck {
  allowed: boolean;
  experimentId: string;
  maxDurationHours: number | null;
  elapsedHours: number;
  startedAt: string | null;
  expiresAt: string | null;
  reason?: string;
}

export class ExperimentBudgetGovernor {
  private db: Database;
  private revenue: RevenueStore;

  constructor(db: Database) {
    this.db = db;
    this.revenue = new RevenueStore(db);
  }

  checkInferenceBudget(
    experimentId: string,
    estimatedAdditionalCostCents: number,
  ): ExperimentInferenceBudgetCheck {
    const experiment = this.revenue.getExperiment(experimentId);

    if (!experiment) {
      return {
        allowed: false,
        experimentId,
        currentInferenceCostCents: 0,
        estimatedAdditionalCostCents,
        limitCents: 0,
        remainingCents: 0,
        reason: `Revenue experiment not found: ${experimentId}`,
      };
    }

    const currentInferenceCostCents =
      inferenceGetExperimentCost(this.db, experimentId);

    const limitCents = experiment.maxInferenceCostCents;

    const invalidReason = this.getBudgetBlockReason(
      experimentId, experiment.status, limitCents, estimatedAdditionalCostCents,
    );
    if (invalidReason) {
      return {
        allowed: false,
        experimentId,
        currentInferenceCostCents,
        estimatedAdditionalCostCents,
        limitCents,
        remainingCents: 0,
        reason: invalidReason,
      };
    }

    const projectedCost =
      currentInferenceCostCents + pendingInferenceCost(this.db, { experimentId }) + estimatedAdditionalCostCents;

    const remainingCents = Math.max(
      0,
      limitCents - currentInferenceCostCents - pendingInferenceCost(this.db, { experimentId }),
    );

    if (projectedCost > limitCents) {
      return {
        allowed: false,
        experimentId,
        currentInferenceCostCents,
        estimatedAdditionalCostCents,
        limitCents,
        remainingCents,
        reason:
          `Experiment inference budget exceeded: ` +
          `${currentInferenceCostCents}c spent + ` +
          `${estimatedAdditionalCostCents}c estimated > ` +
          `${limitCents}c limit`,
      };
    }

    return {
      allowed: true,
      experimentId,
      currentInferenceCostCents,
      estimatedAdditionalCostCents,
      limitCents,
      remainingCents,
    };
  }

  checkTotalBudget(
    experimentId: string,
    estimatedAdditionalCostCents: number = 0,
  ): ExperimentTotalBudgetCheck {
    const experiment = this.revenue.getExperiment(experimentId);

    if (!experiment) {
      return {
        allowed: false,
        experimentId,
        economicCostCents: 0,
        inferenceCostCents: 0,
        currentTotalCostCents: 0,
        estimatedAdditionalCostCents,
        limitCents: 0,
        remainingCents: 0,
        reason: `Revenue experiment not found: ${experimentId}`,
      };
    }

    const economics = this.revenue.getForecastVsActual(experimentId);
    const inferenceCostCents =
      inferenceGetExperimentCost(this.db, experimentId);
    // Forecast/actual now includes inference; retain a separate economic
    // component for reporting without charging inference twice.
    const economicCostCents = (economics?.actualCostCents ?? 0) - inferenceCostCents;

    const currentTotalCostCents =
      economicCostCents + inferenceCostCents;

    const limitCents = experiment.maxBudgetCents;

    const invalidReason = this.getBudgetBlockReason(
      experimentId, experiment.status, limitCents, estimatedAdditionalCostCents,
    );
    if (invalidReason) {
      return {
        allowed: false,
        experimentId,
        economicCostCents,
        inferenceCostCents,
        currentTotalCostCents,
        estimatedAdditionalCostCents,
        limitCents,
        remainingCents: 0,
        reason: invalidReason,
      };
    }

    const projectedCost =
      currentTotalCostCents + pendingInferenceCost(this.db, { experimentId }) + pendingOperationCost(this.db,experimentId) + estimatedAdditionalCostCents;

    const remainingCents = Math.max(
      0,
      limitCents - currentTotalCostCents - pendingInferenceCost(this.db, { experimentId }) - pendingOperationCost(this.db,experimentId),
    );

    if (projectedCost > limitCents) {
      return {
        allowed: false,
        experimentId,
        economicCostCents,
        inferenceCostCents,
        currentTotalCostCents,
        estimatedAdditionalCostCents,
        limitCents,
        remainingCents,
        reason:
          `Experiment total budget exceeded: ` +
          `${currentTotalCostCents}c spent + ` +
          `${estimatedAdditionalCostCents}c estimated > ` +
          `${limitCents}c limit`,
      };
    }

    return {
      allowed: true,
      experimentId,
      economicCostCents,
      inferenceCostCents,
      currentTotalCostCents,
      estimatedAdditionalCostCents,
      limitCents,
      remainingCents,
    };
  }
  private getBudgetBlockReason(
    experimentId: string,
    status: string,
    limitCents: number,
    estimatedCostCents: number,
  ): string | undefined {
    if (status !== "planned" && status !== "running") {
      return `Experiment ${experimentId} is ${status}`;
    }
    if (!Number.isSafeInteger(limitCents) || limitCents < 0 ||
        !Number.isSafeInteger(estimatedCostCents) || estimatedCostCents < 0) {
      return "Invalid experiment budget or cost estimate";
    }
    const experiment = this.revenue.getExperiment(experimentId)!;
    const opportunity = this.revenue.getOpportunity(experiment.opportunityId);
    if (!opportunity || !["validating", "active", "scale"].includes(opportunity.status)) {
      return "Experiment opportunity is not active for validation or execution";
    }
    if(this.revenue.hasEquivalentPendingValidation(experimentId))return 'Equivalent validation already has unresolved work; reuse its result before funding a duplicate';
    if(profitReconciliationBlocked(this.db,experiment.opportunityId)||reconciledProfitEvidence(this.db,experiment.opportunityId).some(e=>!e.reconciled))
      return 'Profit reconciliation discrepancy; affected opportunity paused';
    const {block:profitabilityBlock,ceiling}=profitabilityAdmission(this.db,experiment.opportunityId);
    if(profitabilityBlock&&!(profitabilityBlock==='Profitability governor: REVALIDATE'&&revalidationAdmission(this.db,experimentId,estimatedCostCents)?.allowed))return profitabilityBlock;
    if(ceiling!==null&&(this.revenue.getForecastVsActual(experimentId)!.actualCostCents+
      pendingInferenceCost(this.db,{experimentId})+pendingOperationCost(this.db,experimentId)+estimatedCostCents>ceiling))
      return 'Profitability validation or scaling ceiling exceeded';
    // Admission validates stored forecasts too: legacy/imported rows can bypass
    // store write validation. Existing reservations must remain available for settlement.
    try {
      validateEconomicNumbers(opportunity);
      validateEconomicNumbers(experiment);
    } catch {
      return "Invalid stored opportunity or experiment economics; explicit review required";
    }
    // Only previously completed demand contracts can revoke this admission.
    // Fresh hypotheses remain eligible for bounded validation, not for scale.
    // Assessment of completed contracts does not call budget admission again.
    const revalidation=revalidationAdmission(this.db,experimentId,estimatedCostCents);
    if(revalidation&&!revalidation.allowed)return revalidation.reason!;
    if(opportunityDemandEvidence(this.db,experiment.opportunityId).blocked&&!revalidation?.allowed)
      return "Demand evidence changed; reconcile or revalidate before new spending";
    return researchAdmissionBlock(this.db,experimentId);
  }

  checkDuration(experimentId: string): ExperimentDurationCheck {
    const experiment = this.revenue.getExperiment(experimentId);

    if (!experiment) {
      return {
        allowed: false,
        experimentId,
        maxDurationHours: null,
        elapsedHours: 0,
        startedAt: null,
        expiresAt: null,
        reason: `Revenue experiment not found: ${experimentId}`,
      };
    }

    const maxDurationHours = experiment.maxDurationHours;

    if (maxDurationHours !== null && (!Number.isFinite(maxDurationHours) || maxDurationHours < 0)) {
      return {allowed:false,experimentId,maxDurationHours,elapsedHours:0,startedAt:experiment.startedAt,
        expiresAt:null,reason:'Invalid experiment duration; reconciliation required'};
    }
    if (maxDurationHours === null || maxDurationHours === 0) {
      return {
        allowed: true,
        experimentId,
        maxDurationHours,
        elapsedHours: 0,
        startedAt: experiment.startedAt,
        expiresAt: null,
      };
    }

    const rawStart = experiment.startedAt ?? experiment.createdAt;
    const normalizedStart =
      rawStart.includes("T")
        ? rawStart
        : rawStart.replace(" ", "T") + "Z";

    const startMs = Date.parse(normalizedStart);

    if (!Number.isFinite(startMs)) {
      return {
        allowed: false,
        experimentId,
        maxDurationHours,
        elapsedHours: 0,
        startedAt: rawStart,
        expiresAt: null,
        reason: `Invalid experiment start timestamp: ${rawStart}`,
      };
    }

    const nowMs = Date.now();
    const expiryMs = startMs + maxDurationHours * 3_600_000;
    if (!Number.isFinite(nowMs) || startMs > nowMs || !Number.isFinite(expiryMs) || Math.abs(expiryMs) > 8.64e15) {
      return {allowed:false,experimentId,maxDurationHours,elapsedHours:0,startedAt:rawStart,
        expiresAt:null,reason:'Invalid or future experiment timing; reconciliation required'};
    }
    const elapsedHours = Math.max(0, (nowMs - startMs) / 3_600_000);
    const expiresAt = new Date(expiryMs).toISOString();

    if (elapsedHours >= maxDurationHours) {
      return {
        allowed: false,
        experimentId,
        maxDurationHours,
        elapsedHours,
        startedAt: rawStart,
        expiresAt,
        reason:
          `Experiment duration exceeded: ` +
          `${elapsedHours.toFixed(2)}h elapsed >= ` +
          `${maxDurationHours}h limit`,
      };
    }

    return {
      allowed: true,
      experimentId,
      maxDurationHours,
      elapsedHours,
      startedAt: rawStart,
      expiresAt,
    };
  }
  stopExperiment(experimentId: string, reason: string): void {
    const experiment = this.revenue.getExperiment(experimentId);

    if (!experiment) return;

    if (experiment.status !== "running" && experiment.status !== "planned") {
      return;
    }

    this.revenue.transitionExperimentStatus(
      experimentId,
      "stopped",
      reason,
    );
  }
}
