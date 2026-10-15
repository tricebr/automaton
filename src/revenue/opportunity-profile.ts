import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import {assertNoKnownSecrets} from '../observability/redaction.js';
import {assertNoPersonnelCostInputs} from './personnel-cost-policy.js';

/** Sidecar preserves the established opportunity schema and historical rows.
 * All probabilities use [0,1]; missing evidence is explicit, not a high score. */
export interface OpportunityProfile {
  opportunityId: string;
  revisionId: string;
  capitalRequiredCents: number;
  startupCostCents: number;
  ongoingCostCents: number;
  validationCostCents: number;
  timeToValidationHours: number;
  timeToRevenueHours: number;
  maximumLossCents: number;
  opportunityCostCents: number;
  liquidityDays: number;
  scalability: number;
  repeatability: number;
  automationPotential: number;
  reversibility: number;
  evidenceQuality: number;
  /** Declared common dependencies/assumptions, not measured correlation. */
  dependencyIds?:string[];
  riskFactorIds?:string[];
  switchingHours?:number;
}
function validate(input: OpportunityProfile) {
  assertNoPersonnelCostInputs(input);
  if (!input || ![input.opportunityId,input.revisionId].every(id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(id)) ||
      ![input.capitalRequiredCents,input.startupCostCents,input.ongoingCostCents,input.validationCostCents,input.maximumLossCents,input.opportunityCostCents]
        .every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100_000_000) ||
      ![input.timeToValidationHours,input.timeToRevenueHours,input.liquidityDays].every(n=>Number.isFinite(n)&&n>=0&&n<=100_000) ||
      ![input.scalability,input.repeatability,input.automationPotential,input.reversibility,input.evidenceQuality].every(n=>Number.isFinite(n)&&n>=0&&n<=1)) {
    throw new Error("Invalid opportunity profile");
  }
  for(const list of [input.dependencyIds,input.riskFactorIds])if(list!==undefined&&(!Array.isArray(list)||list.length>20||new Set(list).size!==list.length||list.some(s=>typeof s!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(s))))throw new Error('Invalid dependency or risk-factor scope');
  if(input.switchingHours!==undefined&&(!Number.isFinite(input.switchingHours)||input.switchingHours<0||input.switchingHours>100000))throw new Error('Invalid dependency switching time');
}
export class OpportunityProfiles {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS obolus_opportunity_profiles(sequence INTEGER PRIMARY KEY,revision_id TEXT NOT NULL UNIQUE,
      opportunity_id TEXT NOT NULL REFERENCES revenue_opportunities(id),payload TEXT NOT NULL,digest TEXT NOT NULL);`);
  }
  record(profile: OpportunityProfile) {
    validate(profile);
    assertNoKnownSecrets(profile);
    // Only defined fields are persisted; arbitrary strings/secrets have no slot.
    const keys: (keyof OpportunityProfile)[] = ["opportunityId","revisionId","capitalRequiredCents","startupCostCents","ongoingCostCents",
      "validationCostCents","timeToValidationHours","timeToRevenueHours","maximumLossCents","opportunityCostCents","liquidityDays",
      "scalability","repeatability","automationPotential","reversibility","evidenceQuality","dependencyIds","riskFactorIds","switchingHours"];
    const payload = JSON.stringify(Object.fromEntries(keys.map(key=>[key,profile[key]])));
    const digest = createHash("sha256").update(payload).digest("hex");
    this.db.transaction(()=>{
      const previous=this.db.prepare("SELECT digest FROM obolus_opportunity_profiles WHERE revision_id=?").get(profile.revisionId) as {digest:string}|undefined;
      if(previous){if(previous.digest!==digest)throw new Error("Conflicting opportunity revision");return;}
      if(!this.db.prepare("SELECT 1 FROM revenue_opportunities WHERE id=?").get(profile.opportunityId))throw new Error("Missing opportunity");
      this.db.prepare("INSERT INTO obolus_opportunity_profiles(revision_id,opportunity_id,payload,digest) VALUES(?,?,?,?)")
        .run(profile.revisionId,profile.opportunityId,payload,digest);
    }).immediate();
  }
}
export function latestOpportunityProfile(db:Database,opportunityId:string):OpportunityProfile|null {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='obolus_opportunity_profiles'").get())return null;
  const row=db.prepare("SELECT payload,digest FROM obolus_opportunity_profiles WHERE opportunity_id=? ORDER BY sequence DESC LIMIT 1").get(opportunityId) as {payload:string;digest:string}|undefined;
  if(!row)return null;
  if(createHash("sha256").update(row.payload).digest("hex")!==row.digest)throw new Error("Corrupt opportunity profile");
  const profile=JSON.parse(row.payload) as OpportunityProfile;validate(profile);
  if(profile.opportunityId!==opportunityId)throw new Error("Opportunity profile attribution mismatch");
  return profile;
}

/** Cost calibration is conservative and only uses completed matched estimates.
 * Never infer increased success probabilities from self-reported revenue. */
export function calibrateValidationCost(baseCents:number, history:readonly {forecastCostCents:number;actualCostCents:number;resolved:boolean}[]) {
  if(!Number.isSafeInteger(baseCents)||baseCents<0||history.length>100)throw new Error("Invalid calibration input");
  const ratios=history.filter(row=>row.resolved&&Number.isSafeInteger(row.forecastCostCents)&&row.forecastCostCents>0&&
    Number.isSafeInteger(row.actualCostCents)&&row.actualCostCents>=0).map(row=>row.actualCostCents/row.forecastCostCents).sort((a,b)=>a-b);
  const multiplier=ratios.length>=3?Math.max(1,ratios[Math.ceil(ratios.length*0.75)-1]):1;
  // A zero forecast has no defined cost ratio. Do not silently discard repeated
  // "free" experiments that actually consumed cash. This absolute floor only
  // applies to a new zero forecast; differently sized paid work keeps ratio scaling.
  const zeroForecastCosts=history.filter(row=>row.resolved&&row.forecastCostCents===0&&
    Number.isSafeInteger(row.actualCostCents)&&row.actualCostCents>=0)
    .map(row=>row.actualCostCents).sort((a,b)=>a-b);
  const observedFreeCostFloorCents=baseCents===0&&zeroForecastCosts.length>=3?
    zeroForecastCosts[Math.ceil(zeroForecastCosts.length*0.75)-1]:0;
  const calibratedCents=Math.max(Math.ceil(baseCents*multiplier),observedFreeCostFloorCents);
  if(!Number.isSafeInteger(calibratedCents))throw new Error("Calibration exceeds safe arithmetic");
  return {calibratedCents,samples:ratios.length,multiplier,zeroForecastSamples:zeroForecastCosts.length,observedFreeCostFloorCents,verifiedProbability:null,
    limitation:"Upper-quartile cost ratio; repeated resolved zero forecasts supply an absolute floor for new zero forecasts. Descriptive comparable history only, not a confidence bound or proof of demand or future performance."};
}
