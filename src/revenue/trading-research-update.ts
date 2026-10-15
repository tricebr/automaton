/** Reviewed source synthesis plus a reproducible exploratory experiment.
 * Evidence for learning, not an execution policy or a trained-model claim. */
export function tradingResearchUpdate(){return {
 reviewedAt:'2026-10-11',status:'research-only',liveAuthorized:false,
 objective:'Seek sustainable net profitability subject to explicit capital and loss constraints. Retain no-action as a candidate; neither trade frequency nor maximum historical return is the objective.',
 sources:[
  {id:'update-pbo',url:'https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf',scope:'Abstract and introduction reviewed; no CSCV replication claimed',
   lesson:'Repeated trials on one history increase false discoveries. Preserve the number of attempted configurations, including failures, and do not relabel reused data as untouched.'},
  {id:'update-daytraders',url:'https://faculty.haas.berkeley.edu/odean/papers/Day%20Traders/Day%20Trading%20and%20Learning%20110217.pdf',scope:'Abstract reviewed; Taiwan 1992-2006 study, not a current crypto success estimate',
   lesson:'The studied population had negative aggregate performance; persistence after losses is not proof of skill. Separate experience, measured competence and net profitability.'},
  {id:'update-inventory',url:'https://arxiv.org/abs/1206.4810',scope:'Author abstract only; theoretical and numerical results not replicated',
   lesson:'Market-making research links directional quoting with inventory risk and terminal inventory penalties. Apparent spread capture must be evaluated together with inventory losses and liquidation costs.'},
  {id:'update-queue',url:'https://www.cmegroup.com/articles/faqs/market-by-order-mbo.html',scope:'MBO versus MBP and priority sections reviewed; CME-specific mechanics',
   lesson:'Aggregated price depth cannot establish exact queue position. Order identity and priority changes matter; do not assume a passive fill merely because a candle touches a limit.'}
 ],
 comparison:{artifact:'artifacts/trading-comparison-20261011/results.json',protocol:'artifacts/trading-comparison-20261011/protocol.json',
  symbols:['BTCUSDT','ETHUSDT','SOLUSDT'],interval:'15m',start:'2026-10-01T00:00:00Z',endExclusive:'2026-10-11T00:00:00Z',
  barsPerSymbol:960,strategyVariants:12,families:6,capitalQuoteScenarios:[100,100000],baseReports:78,
  note:'72 single-candidate training-gated reports plus 6 training-selector reports, each also evaluated with 2x and 3x costs. Overlapping paths are not independent evidence.',
  basePositiveReports:3,reportsWithTrades:6,positiveAcrossAllCostScenarios:0,untouchedHoldout:false,
  smallCapitalResult:'No trades in 100-USDT scenario with the whole-base-unit model. This does not establish impossibility with fractional lots.',
  decision:'No strategy qualifies for promotion from this experiment.',
  limits:'Ten days of public candles, no independent feed reconciliation. Whole-unit long-only model; fixed costs, not authenticated account fees. No tick replay, queue simulation, latency calibration or proof of HFT profitability. 100000 USDT is a hypothetical comparison capital, not user funding or authorization.'},
 lessons:[
  {topic:'Costs',application:'The SOL selector made 67.80 quote units on one simulated trade with 100000 quote units of capital, but lost 131.30 at double costs. One profitable trade is insufficient evidence; the 2x and 3x stress failures prevent promotion.'},
  {topic:'Research selection',application:'A single-variant report still applies the training eligibility gate. No trades can reflect affordability or insufficient training evidence, not absence of raw signals. Inspect selections before interpreting inactivity.'},
  {topic:'HFT identifiability',application:'Require sequenced events, matching rules, latency and cancel acknowledgements. Test adverse selection conditional on fills, partial fills, fees, inventory and end-of-session liquidation. Candle outcomes cannot substitute for these inputs.'},
  {topic:'Next experiment',application:'Freeze fractional lot sizing and venue-specific fee assumptions before another comparison. Obtain a fresh prospective paper interval, record all rejected signals and compare to cash and buy-and-hold without retuning revealed results.'}
 ],
 teachingCase:{kind:'synthetic-worked-example',question:'A maker fills 100 units, earns 0.02 per unit relative to decision mid, pays 0.50 fees, and the filled inventory moves adversely by 0.03 per unit. Ignore all other costs. What is the marked result?',
 answer:'2.00 spread advantage minus 0.50 fees minus 3.00 adverse movement = -1.50 quote units. This arithmetic is not a fill probability model or a strategy backtest.'},
 deployment:'Available through the source knowledge tool after build; the existing running runtime must be checked separately. No runtime restart or trading activation implied.'
};}
