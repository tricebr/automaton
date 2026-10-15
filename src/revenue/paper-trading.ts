/** Offline, cash-only long positions. No broker, wallet or network dependencies. */
export interface PaperPlan {
  currency?: "USD" | "CHF" | "EUR";
  symbol: string;
  thesis: string;
  entryCents: number;
  stopCents: number;
  targetsCents: number[];
  exitRule: string;
  riskFraction?: number;
}
export interface Friction { feeBps: number; slippageBps: number; minimumFeeCents?: number }
/** Explicit offline lot assumptions, never authenticated exchange filters. */
export interface PaperLotRules { scale: number; stepAtoms: number; minAtoms: number; maxAtoms: number; minNotionalCents: number }
export function fractionalPaperQuote(entryCents: number, exitCents: number, atoms: number, rules: PaperLotRules, f: Friction) {
  validateFriction(f);
  if (!rules || ![entryCents,exitCents,atoms,rules.scale,rules.stepAtoms,rules.minAtoms,rules.maxAtoms].every(n=>Number.isSafeInteger(n)&&n>0) ||
    rules.scale>100000000 || rules.maxAtoms>1000000000000 || rules.minAtoms>rules.maxAtoms ||
    !Number.isSafeInteger(rules.minNotionalCents)||rules.minNotionalCents<0||atoms<rules.minAtoms||atoms>rules.maxAtoms||atoms%rules.stepAtoms!==0 ||
    !Number.isInteger(f.feeBps)||!Number.isInteger(f.slippageBps)) throw new Error('Invalid paper lot assumptions');
  const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
  const denominator=BigInt(rules.scale)*10000n;
  const raw=BigInt(entryCents)*BigInt(atoms);
  if(raw<BigInt(rules.minNotionalCents)*BigInt(rules.scale))throw new Error('Paper minimum notional');
  const entry=ceil(raw*BigInt(10000+f.slippageBps),denominator);
  const exit=BigInt(exitCents)*BigInt(atoms)*BigInt(10000-f.slippageBps)/denominator;
  const charge=(n:bigint)=>{const v=ceil(n*BigInt(f.feeBps),10000n);return v>BigInt(f.minimumFeeCents??0)?v:BigInt(f.minimumFeeCents??0);};
  const entryFee=charge(entry),exitFee=charge(exit);
  const safe=(n:bigint)=>{const v=Number(n);if(!Number.isSafeInteger(v))throw new Error('Paper lot arithmetic limit');return v;};
  return {mode:'paper-fractional' as const,atoms,scale:rules.scale,committedCents:safe(entry+entryFee),
    proceedsCents:safe(exit-exitFee),entryFeeCents:safe(entryFee),exitFeeCents:safe(exitFee),
    netPnlCents:safe(exit-exitFee-entry-entryFee),exitBelowMinimum:BigInt(exitCents)*BigInt(atoms)<BigInt(rules.minNotionalCents)*BigInt(rules.scale),
    executionAuthorized:false,accountRulesVerified:false,limits:'Quote-currency fees only; cent-conservative rounding. No liquidity, tax, funding or executable exit guarantee.'};
}
export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface PaperPosition {
  mode: "paper";
  plan: PaperPlan;
  units: number;
  entryFillCents: number;
  entryFeeCents: number;
  committedCents: number;
  plannedLossCents: number;
}
export interface PaperTrade extends PaperPosition {
  exitTime: number;
  exitFillCents: number;
  exitFeeCents: number;
  netPnlCents: number;
  reason: "stop" | "target" | "window_end";
}
function positiveCents(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
export function validateFriction(f: Friction): void {
  if (!f || ![f.feeBps, f.slippageBps].every(n => Number.isFinite(n) && n >= 0 && n < 10000) ||
      (f.minimumFeeCents !== undefined && (!Number.isSafeInteger(f.minimumFeeCents) || f.minimumFeeCents < 0))) {
    throw new Error("Invalid paper fees/slippage");
  }
}
const fee = (amount: number, f: Friction) => Math.max(f.minimumFeeCents ?? 0, Math.ceil(amount * f.feeBps / 10000));
const buyFill = (price: number, f: Friction) => Math.ceil(price * (1 + f.slippageBps / 10000));
const sellFill = (price: number, f: Friction) => Math.max(0, Math.floor(price * (1 - f.slippageBps / 10000)));

export function sizePaperPosition(plan: PaperPlan, equityCents: number, availableCashCents: number, f: Friction): PaperPosition {
  validateFriction(f);
  const risk = plan.riskFraction ?? 0.01;
  if (!positiveCents(equityCents) || !Number.isSafeInteger(availableCashCents) || availableCashCents < 0 ||
      !positiveCents(plan.entryCents) || !positiveCents(plan.stopCents) ||
      !plan.symbol.trim() || !plan.thesis.trim() || !plan.exitRule.trim() ||
      !Number.isFinite(risk) || risk <= 0 || risk > 0.02 ||
      plan.stopCents >= plan.entryCents || (plan.entryCents - plan.stopCents) / plan.entryCents > 0.05 ||
      !plan.targetsCents.length || plan.targetsCents.some(p => !positiveCents(p) || p <= plan.entryCents)) {
    throw new Error("Invalid paper plan: require thesis, exit, long stop <=5%, targets and risk <=2%");
  }
  const entry = buyFill(plan.entryCents, f);
  const stopped = sellFill(plan.stopCents, f);
  const cash = Math.min(equityCents, availableCashCents);
  // Fees (including minima) apply per order, not per unit. Both constraints are monotone.
  let units = 0, upper = Math.floor(cash / entry);
  while (units < upper) {
    const candidate = units + Math.ceil((upper - units) / 2);
    const cost = entry * candidate + fee(entry * candidate, f);
    const loss = (entry - stopped) * candidate + fee(entry * candidate, f) + fee(stopped * candidate, f);
    if (Number.isSafeInteger(cost) && Number.isSafeInteger(loss) && cost <= cash && loss <= Math.floor(equityCents * risk)) units = candidate;
    else upper = candidate - 1;
  }
  if (units < 1) throw new Error("Insufficient cash or risk budget for one whole paper unit");
  const entryFeeCents = fee(entry * units, f);
  const committedCents = entry * units + entryFeeCents;
  const plannedLossCents = (entry - stopped) * units + entryFeeCents + fee(stopped * units, f);
  if (![committedCents, plannedLossCents].every(Number.isSafeInteger)) throw new Error("Paper position arithmetic limit exceeded");
  if (plannedLossCents > Math.floor(committedCents / 20)) {
    throw new Error("Planned loss including fees/slippage exceeds 5% of committed trade capital");
  }
  return { mode: "paper", plan: structuredClone(plan), units, entryFillCents: entry,
    entryFeeCents, committedCents, plannedLossCents };
}

export function validateBars(bars: readonly Bar[]): void {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!Number.isSafeInteger(b.time) || (i > 0 && b.time <= bars[i - 1].time) ||
        ![b.open, b.high, b.low, b.close].every(positiveCents) ||
        b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || b.low > b.high) {
      throw new Error("Invalid or nonchronological OHLC bars");
    }
  }
}

/** Descriptive passive comparator, not a permissible order plan. Full cash
 * exposure deliberately differs from risk-sized active trades. No dividends,
 * funding, taxes, liquidity or fractional lot assumptions are fabricated. */
export function buyAndHoldPaper(bars: readonly Bar[], equityCents: number, f: Friction) {
  if (!Array.isArray(bars) || !bars.length || bars.length > 5000 ||
      !positiveCents(equityCents) || equityCents > 100_000_000) throw new Error('Invalid passive comparison');
  validateBars(bars); validateFriction(f);
  if (bars.some(b=>b.high>100_000_000)) throw new Error('Passive comparison price bound');
  const entry=buyFill(bars[0].open,f),exit=sellFill(bars.at(-1)!.close,f);
  let units=0,upper=Math.floor(equityCents/entry);
  while(units<upper){
    const n=units+Math.ceil((upper-units)/2),cost=n*entry+fee(n*entry,f);
    if(Number.isSafeInteger(cost)&&cost<=equityCents)units=n;else upper=n-1;
  }
  const entryFeeCents=units?fee(units*entry,f):0,exitFeeCents=units?fee(units*exit,f):0;
  const committedCents=units*entry+entryFeeCents,remainingCashCents=equityCents-committedCents;
  const finalEquityCents=remainingCashCents+units*exit-exitFeeCents;
  const grossPnlCents=units*(bars.at(-1)!.close-bars[0].open);
  const slippageDragCents=units*(entry-bars[0].open+bars.at(-1)!.close-exit);
  let peak=equityCents,ohlcDrawdownUpperBoundCents=0;
  const safe=(n:number)=>{if(!Number.isSafeInteger(n))throw new Error('Passive comparison arithmetic limit');return n;};
  for(const bar of bars){
    const value=(price:number)=>{const amount=safe(units*sellFill(price,f));return safe(remainingCashCents+amount-(units?fee(amount,f):0));};
    peak=Math.max(peak,value(bar.high));
    ohlcDrawdownUpperBoundCents=Math.max(ohlcDrawdownUpperBoundCents,safe(peak-value(bar.low)));
  }
  [committedCents,finalEquityCents,grossPnlCents,slippageDragCents,entryFeeCents,exitFeeCents].forEach(safe);
  return {mode:'paper-comparator',start:bars[0].time,end:bars.at(-1)!.time,units,initialEquityCents:equityCents,
    entryFillCents:entry,exitFillCents:exit,entryFeeCents,exitFeeCents,committedCents,remainingCashCents,
    finalEquityCents,netPnlCents:safe(finalEquityCents-equityCents),grossPnlCents,slippageDragCents,
    ohlcDrawdownUpperBoundCents,executionAuthorized:false,actualAccountCostsVerified:false,
    comparability:'Same period and initial cash ceiling, NOT matched risk or exposure. Single asset, not a diversified index. Whole units. No personnel costs. Fees/slippage are supplied assumptions; taxes, funding and liquidity remain outside this model.'};
}

export function simulatePaperExit(position: PaperPosition, bars: readonly Bar[], f: Friction): PaperTrade {
  validateFriction(f); validateBars(bars);
  if (!bars.length) throw new Error("Paper exit needs at least one bar");
  const stop = position.plan.stopCents;
  const target = Math.min(...position.plan.targetsCents);
  let price = bars[bars.length - 1].close;
  let time = bars[bars.length - 1].time;
  let reason: PaperTrade["reason"] = "window_end";
  for (const bar of bars) {
    // Stop wins when both levels are touched: OHLC cannot establish their order.
    if (bar.low <= stop) { price = Math.min(bar.open, stop); time = bar.time; reason = "stop"; break; }
    if (bar.high >= target) { price = target; time = bar.time; reason = "target"; break; }
  }
  const exitFillCents = sellFill(price, f);
  const exitFeeCents = fee(exitFillCents * position.units, f);
  return { ...position, exitTime: time, exitFillCents, exitFeeCents, reason,
    netPnlCents: exitFillCents * position.units - exitFeeCents - position.committedCents };
}

export interface WalkForwardResult {
  mode: "paper";
  initialEquityCents: number;
  finalEquityCents: number;
  netPnlCents: number;
  windows: { trainStart: number; trainEnd: number; testStart: number; testEnd: number }[];
  trades: PaperTrade[];
  rejectedPlans: number;
  /** Conservative high-before-low OHLC envelope, not observed tick drawdown. */
  ohlcDrawdownUpperBoundCents: number;
}
export type PaperSignal = (past: readonly Bar[], nextOpenCents: number) => PaperPlan | null;

/** Non-overlapping OOS windows, refit only on preceding bars. One position at a time. */
export function walkForwardPaper(
  bars: readonly Bar[], trainSize: number, testSize: number, equityCents: number, f: Friction,
  fit: (training: readonly Bar[]) => PaperSignal,
): WalkForwardResult {
  validateBars(bars); validateFriction(f);
  if (![trainSize, testSize].every(n => Number.isSafeInteger(n) && n > 0) ||
      bars.length < trainSize + testSize || !positiveCents(equityCents)) throw new Error("Invalid walk-forward settings");
  const result: WalkForwardResult = { mode: "paper", initialEquityCents: equityCents, finalEquityCents: equityCents,
    netPnlCents: 0, windows: [], trades: [], rejectedPlans: 0, ohlcDrawdownUpperBoundCents: 0 };
  let envelopePeak = equityCents;
  const copy = (items: readonly Bar[]): readonly Bar[] => Object.freeze(items.map(b => Object.freeze({ ...b })));
  for (let start = trainSize; start + testSize <= bars.length; start += testSize) {
    const end = start + testSize;
    const signal = fit(copy(bars.slice(start - trainSize, start)));
    result.windows.push({ trainStart: bars[start - trainSize].time, trainEnd: bars[start - 1].time,
      testStart: bars[start].time, testEnd: bars[end - 1].time });
    for (let i = start; i < end && result.finalEquityCents > 0; i++) {
      const plan = signal(copy(bars.slice(start - trainSize, i)), bars[i].open);
      if (!plan) continue;
      // Signals decide at the next open. Do not grant an earlier, better fill.
      if (plan.entryCents !== bars[i].open) { result.rejectedPlans++; continue; }
      let position: PaperPosition;
      try { position = sizePaperPosition(plan, result.finalEquityCents, result.finalEquityCents, f); }
      catch { result.rejectedPlans++; continue; }
      const trade = simulatePaperExit(position, bars.slice(i, end), f);
      // OHLC does not reveal high/low order or the intrabar exit instant. Use
      // high-before-low including the exit bar as a conservative envelope;
      // this can overstate executable drawdown and never proves live safety.
      for (let j=i;j<end&&bars[j].time<=trade.exitTime;j++) {
        const liquidatedEquity=(price:number)=>{
          const gross=sellFill(price,f)*position.units;
          const value=result.finalEquityCents+gross-fee(gross,f)-position.committedCents;
          if(!Number.isSafeInteger(value))throw new Error('Paper valuation arithmetic limit exceeded');
          return value;
        };
        envelopePeak=Math.max(envelopePeak,liquidatedEquity(bars[j].high));
        const drawdown=envelopePeak-liquidatedEquity(bars[j].low);
        if(!Number.isSafeInteger(drawdown))throw new Error('Paper drawdown arithmetic limit exceeded');
        result.ohlcDrawdownUpperBoundCents=Math.max(result.ohlcDrawdownUpperBoundCents,drawdown);
      }
      result.trades.push(trade);
      result.finalEquityCents += trade.netPnlCents;
      while (i + 1 < end && bars[i + 1].time <= trade.exitTime) i++;
    }
  }
  result.netPnlCents = result.finalEquityCents - equityCents;
  return result;
}
