import { createHash } from "node:crypto";
import { outcomeSensitivity, tradingKnowledge } from "./trading-knowledge.js";
import { validateBars, walkForwardPaper, buyAndHoldPaper, type Bar, type Friction, type PaperSignal, type PaperTrade } from "./paper-trading.js";

export const STRATEGY_FAMILIES = ['momentum','mean-reversion','channel-breakout','moving-average-trend','rsi-recovery','bollinger-reversion'] as const;
export interface StrategyVariant {
  id: string;
  family: typeof STRATEGY_FAMILIES[number];
  lookback: number;
  thresholdBps: number;
  stopBps: number;
  targetBps: number;
}
export interface StrategyResearchInput {
  provenance: "synthetic" | "historical-unverified";
  symbol: string;
  bars: Bar[];
  variants: StrategyVariant[];
  trainSize: number;
  testSize: number;
  equityCents: number;
  friction: Friction;
  minTrainingTrades: number;
  maxTrainingClosedDrawdownFraction: number;
}
/** Fixed research universe. These are experiment parameters, not an approval
 * of capital allocation or a claim of optimal parameters. */
export function strategyCatalogue(): StrategyVariant[] {
  return STRATEGY_FAMILIES.flatMap(family=>[10,20].map(lookback=>({
    id:`${family}-${lookback}`,family,lookback,thresholdBps:0,stopBps:300,targetBps:600,
  })));
}
export function strategySignal(v: StrategyVariant, symbol: string): PaperSignal {
  return (past, entry) => {
    if (past.length < v.lookback) return null;
    const recent = past.slice(-v.lookback);
    const average = recent.reduce((sum, b) => sum + b.close, 0) / recent.length;
    const deviation = (recent.at(-1)!.close / average - 1) * 10000;
    let enter = false;
    const last = recent.at(-1)!.close;
    switch(v.family) {
      case 'momentum': enter = deviation > v.thresholdBps; break;
      case 'mean-reversion': enter = deviation < -v.thresholdBps; break;
      case 'channel-breakout': enter = last > Math.max(...recent.slice(0,-1).map(b=>b.high))*(1+v.thresholdBps/10000); break;
      case 'moving-average-trend': {
        const fast=recent.slice(-Math.max(1,Math.floor(v.lookback/2)));
        enter=fast.reduce((n,b)=>n+b.close,0)/fast.length > average*(1+v.thresholdBps/10000) && last>average;
        break;
      }
      case 'rsi-recovery': {
        let gain=0,loss=0;
        for(let i=1;i<recent.length;i++){const delta=recent[i].close-recent[i-1].close;gain+=Math.max(0,delta);loss+=Math.max(0,-delta);}
        const rsi=gain+loss===0?50:100*gain/(gain+loss);
        enter=rsi<30 && last>recent.at(-2)!.close*(1+v.thresholdBps/10000); break;
      }
      case 'bollinger-reversion': {
        const variance=recent.reduce((n,b)=>n+(b.close-average)**2,0)/recent.length;
        enter=variance>0 && last<average-2*Math.sqrt(variance) && deviation < -v.thresholdBps; break;
      }
      default: throw new Error('Unsupported strategy family');
    }
    if(!enter) return null;
    const stop = Math.ceil(entry * (1 - v.stopBps / 10000));
    if (stop <= 0 || stop >= entry) return null;
    return { symbol, thesis: `Research ${v.id}: ${v.family}, lookback ${v.lookback}, threshold ${v.thresholdBps}bps`,
      entryCents: entry, stopCents: stop, targetsCents: [Math.ceil(entry * (1 + v.targetBps / 10000))],
      riskFraction: 0.01, exitRule: "First target, stop or end of chronological evaluation window" };
  };
}
function closedDrawdown(trades: PaperTrade[], initial: number): number {
  let equity = initial, peak = initial, maximum = 0;
  for (const trade of trades) { equity += trade.netPnlCents; peak = Math.max(peak, equity); maximum = Math.max(maximum, peak - equity); }
  return maximum;
}

/** Fixed candidate universe, training-only selection, forward-only evaluation.
 * A research report never enables a broker or changes a live strategy.
 */
export function researchStrategies(input: StrategyResearchInput) {
  if (!input || !["synthetic", "historical-unverified"].includes(input.provenance) ||
      typeof input.symbol !== "string" || !/^[A-Za-z0-9._-]{1,30}$/.test(input.symbol) ||
      !Array.isArray(input.bars) || input.bars.length > 5000 || !Array.isArray(input.variants) ||
      !input.variants.length || input.variants.length > 20 ||
      ![input.trainSize, input.testSize, input.minTrainingTrades].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(input.equityCents) || input.equityCents <= 0 || input.equityCents > 100_000_000 ||
      !Number.isFinite(input.maxTrainingClosedDrawdownFraction) || input.maxTrainingClosedDrawdownFraction <= 0 || input.maxTrainingClosedDrawdownFraction > 1 ||
      !input.friction || ![input.friction.feeBps, input.friction.slippageBps].every(n => Number.isFinite(n) && n >= 0 && n < 10000)) throw new Error("Invalid strategy research settings");
  validateBars(input.bars);
  if (input.bars.some(b => b.high > 100_000_000)) throw new Error("Research price bound exceeded");
  const ids = new Set<string>();
  for (const v of input.variants) {
    if (!v || typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(v.id) || ids.has(v.id) || !STRATEGY_FAMILIES.includes(v.family) ||
        !Number.isInteger(v.lookback) || v.lookback < 2 || v.lookback >= input.trainSize ||
        ![v.thresholdBps, v.stopBps, v.targetBps].every(Number.isSafeInteger) ||
        v.thresholdBps < 0 || v.thresholdBps > 10000 || v.stopBps < 1 || v.stopBps > 500 || v.targetBps < 1 || v.targetBps > 10000) throw new Error("Invalid or duplicate strategy variant");
    ids.add(v.id);
  }
  const windows = Math.floor((input.bars.length - input.trainSize) / input.testSize);
  if (windows < 1 || windows > 50 || windows * input.trainSize * input.variants.length > 200_000) throw new Error("Invalid or excessive research work budget");
  // Equal warmup and trading intervals for every candidate prevent unequal sample comparisons.
  const warmup = Math.max(...input.variants.map(v => v.lookback));
  const selections: { trainEnd: number; selectedId: string | null; candidates: {
    id: string; netPnlCents: number; closedDrawdownCents: number; trades: number; eligible: boolean; score: number;
  }[] }[] = [];
  const result = walkForwardPaper(input.bars, input.trainSize, input.testSize, input.equityCents, input.friction, training => {
    const candidates = input.variants.map(v => {
      const evaluation = walkForwardPaper(training, warmup, training.length - warmup, input.equityCents, input.friction, () => strategySignal(v, input.symbol));
      const drawdown = closedDrawdown(evaluation.trades, input.equityCents);
      const eligible = evaluation.netPnlCents > 0 && evaluation.trades.length >= input.minTrainingTrades &&
        evaluation.rejectedPlans === 0 && drawdown <= input.equityCents * input.maxTrainingClosedDrawdownFraction;
      return { id: v.id, netPnlCents: evaluation.netPnlCents, closedDrawdownCents: drawdown,
        trades: evaluation.trades.length, eligible, score: evaluation.netPnlCents - drawdown };
    }).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
    const chosen = candidates.find(c => c.eligible && c.score > 0);
    selections.push({ trainEnd: training.at(-1)!.time, selectedId: chosen?.id ?? null, candidates });
    return chosen ? strategySignal(input.variants.find(v => v.id === chosen.id)!, input.symbol) : () => null;
  });
  const inputDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  // Reuse the ORIGINAL training selections under worse execution costs. Do not
  // optimize the selector again against the stress outcome or future prices.
  const frictionStress=[2,3].map(multiplier=>{
    const friction={feeBps:input.friction.feeBps*multiplier,slippageBps:input.friction.slippageBps*multiplier,
      minimumFeeCents:(input.friction.minimumFeeCents??0)*multiplier};
    if(friction.feeBps>=10000||friction.slippageBps>=10000||!Number.isSafeInteger(friction.minimumFeeCents))return {multiplier,status:'outside-model-bounds' as const};
    let index=0;
    const stressed=walkForwardPaper(input.bars,input.trainSize,input.testSize,input.equityCents,friction,()=>{
      const selected=selections[index++].selectedId;
      return selected?strategySignal(input.variants.find(v=>v.id===selected)!,input.symbol):()=>null;
    });
    return {multiplier,status:'evaluated' as const,netPnlCents:stressed.netPnlCents,trades:stressed.trades.length,
      rejectedPlans:stressed.rejectedPlans,ohlcDrawdownUpperBoundCents:stressed.ohlcDrawdownUpperBoundCents};
  });
  const wins=result.trades.filter(t=>t.netPnlCents>0),losses=result.trades.filter(t=>t.netPnlCents<0);
  const grossWins=wins.reduce((n,t)=>n+t.netPnlCents,0),grossLosses=-losses.reduce((n,t)=>n+t.netPnlCents,0);
  const diagnostics={wins:wins.length,losses:losses.length,breakeven:result.trades.length-wins.length-losses.length,
    knowledgeVersion:tradingKnowledge().version,
    candidateVariantsTested:input.variants.length,
    tradeSensitivity:outcomeSensitivity(result.trades.map(t=>t.netPnlCents)),
    windowSensitivity:outcomeSensitivity(result.windows.map(w=>result.trades.filter(t=>t.exitTime>=w.testStart&&t.exitTime<=w.testEnd).reduce((n,t)=>n+t.netPnlCents,0))),
    observedWinFraction:result.trades.length?wins.length/result.trades.length:null,
    averageNetCents:result.trades.length?result.netPnlCents/result.trades.length:null,
    netProfitFactor:grossLosses?grossWins/grossLosses:null,
    feesCents:result.trades.reduce((n,t)=>n+t.entryFeeCents+t.exitFeeCents,0),
    cashBenchmarkNetCents:0,
    passiveBenchmark:buyAndHoldPaper(input.bars.slice(input.trainSize,input.trainSize+windows*input.testSize),input.equityCents,input.friction),
    statisticalProfitProbability:null,
    interpretation:'Descriptive sample metrics only. No-loss samples do not imply infinite edge; null profit factor means undefined. Cash benchmark excludes interest. No statistical independence, calibrated profit probability or live profitability proven.'};
  return { version: 1, mode: "paper-strategy-research", provenance: input.provenance, inputDigest,
    decision: result.netPnlCents > 0 && result.trades.length > 0 ? "further-validation-only" : "insufficient-forward-evidence",
    selections, evaluation: result, diagnostics, frictionStress, closedDrawdownCents: closedDrawdown(result.trades, input.equityCents),
    unusedTailBars: input.bars.length - input.trainSize - windows * input.testSize,
    limits: "Closed-trade drawdown excludes unrealized intratrade losses. evaluation.ohlcDrawdownUpperBoundCents additionally reports a conservative high-before-low OHLC envelope, including exit bars; it can overstate realizable drawdown and is not observed tick risk. Fixed long-only cash strategies; no leverage, broker, live approval or proven profitability. Repeated research on the same dataset is not fresh out-of-sample evidence." };
}
