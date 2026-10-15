import {createHash} from 'node:crypto';

interface Measurement {costCents:number;latencyMs:number;qualityScore:number;safetyPassed:boolean;completed:boolean}
export interface OptimizationComparison {
  mode:'simulation'|'recorded';datasetDigest:string;criteriaDigest:string;baseline:string;candidate:string;
  minimumQuality:number;maximumQualityDrop:number;minimumSavingsPercent:number;maximumLatencyRatio:number;
  cases:{id:string;inputDigest:string;baseline:Measurement;candidate:Measurement}[];
}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const sha=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const name=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_.:/-]{1,100}$/.test(s);
const percentage=(n:number)=>Number.isFinite(n)&&n>=0&&n<=100;

/** Paired descriptive comparison; input attestations are not independent execution receipts. */
export function compareOptimization(input:OptimizationComparison){
  if(!input||!['simulation','recorded'].includes(input.mode)||!sha(input.datasetDigest)||!sha(input.criteriaDigest)||
    !name(input.baseline)||!name(input.candidate)||input.baseline===input.candidate||
    !percentage(input.minimumQuality)||!percentage(input.maximumQualityDrop)||!percentage(input.minimumSavingsPercent)||
    !Number.isFinite(input.maximumLatencyRatio)||input.maximumLatencyRatio<1||input.maximumLatencyRatio>10||
    !Array.isArray(input.cases)||input.cases.length<3||input.cases.length>100)throw Error('Bounded paired comparison with explicit criteria and 3..100 cases required');
  const ids=new Set<string>(),inputs=new Set<string>();
  const sums={baselineCost:0,candidateCost:0,baselineLatency:0,candidateLatency:0,baselineQuality:0,candidateQuality:0};
  const blockers=new Set<string>();
  let costWins=0,qualityLosses=0,minimumPairedSavingsCents=Number.MAX_SAFE_INTEGER;
  const cases=[...input.cases].sort((a,b)=>a.id.localeCompare(b.id));
  for(const row of cases){
    if(!row||!name(row.id)||!sha(row.inputDigest)||ids.has(row.id)||inputs.has(row.inputDigest))throw Error('Unique cases and distinct input digests required');
    ids.add(row.id);inputs.add(row.inputDigest);
    for(const side of ['baseline','candidate'] as const){
      const m=row[side];
      if(!m||![m.costCents,m.latencyMs].every(n=>Number.isSafeInteger(n)&&n>=0)||!percentage(m.qualityScore)||typeof m.completed!=='boolean'||typeof m.safetyPassed!=='boolean')throw Error('Invalid comparison measurement');
      if(!m.completed)blockers.add(`${side}_incomplete`);
      if(!m.safetyPassed)blockers.add(`${side}_safety_failure`);
      if(m.qualityScore<input.minimumQuality)blockers.add(`${side}_quality_below_floor`);
    }
    if(row.candidate.qualityScore<row.baseline.qualityScore){qualityLosses++;if(row.baseline.qualityScore-row.candidate.qualityScore>input.maximumQualityDrop)blockers.add('paired_quality_regression');}
    if(row.candidate.latencyMs>row.baseline.latencyMs*input.maximumLatencyRatio)blockers.add('paired_latency_regression');
    if(row.candidate.costCents<row.baseline.costCents)costWins++;
    minimumPairedSavingsCents=Math.min(minimumPairedSavingsCents,row.baseline.costCents-row.candidate.costCents);
    sums.baselineCost+=row.baseline.costCents;sums.candidateCost+=row.candidate.costCents;
    sums.baselineLatency+=row.baseline.latencyMs;sums.candidateLatency+=row.candidate.latencyMs;
    sums.baselineQuality+=row.baseline.qualityScore;sums.candidateQuality+=row.candidate.qualityScore;
    if(![sums.baselineCost,sums.candidateCost,sums.baselineLatency,sums.candidateLatency].every(Number.isSafeInteger))throw Error('Unsafe comparison totals');
  }
  const savingsCents=sums.baselineCost-sums.candidateCost;
  const savingsPercent=sums.baselineCost>0?savingsCents/sums.baselineCost*100:null;
  if(savingsPercent===null||savingsCents<=0||savingsPercent<input.minimumSavingsPercent)blockers.add('insufficient_measured_savings');
  const manifest={mode:input.mode,datasetDigest:input.datasetDigest,criteriaDigest:input.criteriaDigest,baseline:input.baseline,candidate:input.candidate,
    minimumQuality:input.minimumQuality,maximumQualityDrop:input.maximumQualityDrop,minimumSavingsPercent:input.minimumSavingsPercent,maximumLatencyRatio:input.maximumLatencyRatio,cases};
  return {comparisonId:digest(JSON.stringify(manifest)),mode:input.mode,baseline:input.baseline,candidate:input.candidate,
    datasetDigest:input.datasetDigest,criteriaDigest:input.criteriaDigest,caseCount:cases.length,costWins,qualityLosses,
    baselineCostCents:sums.baselineCost,candidateCostCents:sums.candidateCost,savingsCents,savingsPercent,minimumPairedSavingsCents,
    baselineMeanQuality:sums.baselineQuality/cases.length,candidateMeanQuality:sums.candidateQuality/cases.length,
    blockers:[...blockers].sort(),decision:blockers.size?'reject_candidate':'candidate_for_replication',
    adoptionAuthorized:false,profitabilityProven:false,
    limitation:'Descriptive paired sample only. Supplied measurements and digests do not authenticate execution, preregistration, workload coverage or statistical significance. Recorded mode is not independent verification. Replicate on held-out tasks with attributable cost and quality evidence before adoption; never weaken safety.'};
}
