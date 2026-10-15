import { literatureOverviews } from './trading-literature-data.js';
import { tradingExpertise } from './trading-expertise.js';
import { tradingResearchUpdate } from './trading-research-update.js';
import { eventOpportunityCurriculum } from './event-opportunity.js';
import { tradingThreeStageUpdate } from './trading-three-stage-update.js';
import { tradingWalletCurriculum } from './trading-wallet-curriculum.js';
import { analystKnowledge } from './long-history/trading-context.js';

/** Curated paraphrases, never executable instructions or authority to trade.
 * Source reputation is not evidence that an Obolus strategy is profitable. */
export function tradingKnowledge() {
  return {
    version: 15, reviewedAt: '2026-10-14', liveAuthorized: false,
    centuryAnalyst:{requestedStart:'1926-10-14',requestedEnd:'2026-10-14',lessons:analystKnowledge(),coverage:'Selected primary-source historical episodes and market methodology, not a complete century of executable intraday data.',application:'Compare causal current-market filters against an unchanged baseline on fresh paired observations.',profitabilityProven:false,modelRetrained:false},
    tradingWalletCurriculum: tradingWalletCurriculum(),
    threeStageResearch: tradingThreeStageUpdate(),
    eventOpportunities: eventOpportunityCurriculum(),
    researchUpdate: tradingResearchUpdate(),
    expertise: tradingExpertise(),
    literature: {
      requestedWorks: 150, complete: false, verifiedGlobalRanking: false,
      modelRetrained: false, profitabilityProven: false,
      overviewTargetReached: true, coveredWorks: 150, fullTextsReviewed: 2, publisherOverviewsReviewed: 148,
      coverageLimitation: '148 briefings use reviewed publisher-description passages, not full books, independent critical summaries or chapter-by-chapter study. This is an initial 150-work research map, not completed mastery of 150 books. Global bestseller ranking is unverified; selection is heavily publisher-biased.',
      overviewAccess: {tool:'paper_research_series',action:'literature',defaultLimit:10,maxLimit:20},
      overviewIndex: literatureOverviews().map(({id,title,topic})=>({id,title,topic})),
      researchAgenda: literatureResearchAgenda(),
      scope: 'Original English textual works, not illustrations or modern revised editions. Platform downloads are a readership proxy, not verified readers or global sales ranks. Notes are research context, never execution authority.',
      readWorks: [
        { id: 'barnum-money-getting', title: 'The Art of Money Getting', author: 'P. T. Barnum',
          url: 'https://www.gutenberg.org/ebooks/8581', reviewedAt: '2026-10-10', status: 'full-text-reviewed',
          textSha256: 'ccf68ee545e68995f88d4cd2f534ecae9bf731b8996118d34b5a10bfc4958061',
          popularity: {kind:'gutenberg-downloads-last-30-days',value:10607,globalRank:null},
          sections: ['Introduction','Avoid Debt','Persevere','Do Not Scatter Your Powers','Beware of Outside Operations','Advertise Your Business','Do Not Blab','Preserve Your Integrity'],
          lessons: ['Record cash expenses and preserve reserves.', 'Separate hoped-for proceeds from receipts; success in one activity does not establish skill in another.'],
          rejected: ['Success is inevitable through diligence.', 'Conceal losses to protect reputation.', 'Keep spending on advertising merely because money was already spent.'],
          application: 'Preserve failed trials, settled cash accounting and domain-specific validation; persistence never overrides a stop or budget.',
          testProposal: 'A profitable episode followed by losses must retain both outcomes and must not authorize higher risk or hide losses.',
          limitation: 'Historical entrepreneurial anecdotes and prejudices, not a trading backtest; no modern CFD, options or futures execution evidence.' },
        { id: 'franklin-way-to-wealth', title: 'The Way to Wealth', author: 'Benjamin Franklin',
          url: 'https://www.gutenberg.org/ebooks/43855', reviewedAt: '2026-10-10', status: 'full-text-reviewed',
          textSha256: '66528adb3ebc218fbe12488549757fe766ad7a61ca027acb791b403c69ba591d',
          popularity: {kind:'gutenberg-downloads-last-30-days',value:4823,globalRank:null},
          sections: ['Introduction','I: Industry','II: Care and oversight','III: Frugality and debt','IV: Limits of individual control','Closing auction narrative'],
          lessons: ['Repeated small expenses can exhaust reserves.', 'Knowing a rule does not ensure following it; the closing auction illustrates this gap.'],
          rejected: ['Historical debt-enforcement rules apply today.', 'More activity guarantees wealth.'],
          application: 'Keep runtime controls independent of advice; accumulate cash costs and permit no-action decisions. Track time separately, without personnel charges.',
          testProposal: 'Many individually small cash charges must still trigger the aggregate budget limit; advice cannot bypass enforcement.',
          limitation: 'Historical personal-finance essay in an 1810 edition, not evidence of a profitable trading signal or a current legal rule.' },
      ],
      skippedWorks: [
        {title:'The Psychology of Money',author:'Morgan Housel',
          url:'https://www.harriman-house.com/authors/morgan-housel/the-psychology-of-money/9780857197689',
          status:'publisher-metadata-only',reason:'No authorized complete text obtained; not counted as read. Publisher reports over 10 million sales; older publicity reports smaller historical totals.'},
        {title:'Option Volatility Trading Strategies',author:'Sheldon Natenberg',
          url:'https://onlinelibrary.wiley.com/doi/book/10.1002/9781119204473',
          status:'publisher-metadata-only',reason:'Contents and some free sections listed, but no complete text obtained; not counted as read. Sales rank unverified.'},
      ],
      promotion: 'Full reading does not validate a strategy. New hypotheses require preregistered independent data, cash-cost stress, comparison to no action and fresh paper validation. Do not change risk limits based on book claims.',
    },
    strategyResearch:{tool:'paper_research_series',action:'strategies',status:'unvalidated-hypotheses',purpose:'Compare intraday/scalping/HFT candidates and learn from fresh independent evidence, never from fame or trade frequency.'},
    lessons: [
      { id: 'queue', author: 'CME Group', date: null,
        url: 'https://www.cmegroup.com/articles/faqs/market-by-order-mbo.html',
        evidence: 'Exchange feed documentation',
        lesson: 'Aggregated price levels do not establish exact individual queue position; matching priority and order changes matter.',
        limitation: 'Our snapshot fill model has no passive queue replay or venue matching certification.',
        application: 'HFT and maker profitability remain unverified; require order-event data and matching rules before testing passive fills.' },
      { id: 'events', author: 'Nasdaq', date: null,
        url: 'https://www.nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NQTVITCHSpecification_5.0.pdf',
        evidence: 'TotalView ITCH 5.0 interface specification',
        lesson: 'Distinguish add, execution, cancel, delete and replacement events; reconstruct state chronologically with feed-gap handling.',
        limitation: 'No ITCH adapter, licensed dataset or independently verified replay has been implemented here.',
        application: 'Require deterministic event replay and missing-message rejection before an HFT capability claim.' },
      { id: 'latency-infrastructure', author: 'SEC / Mary Jo White', date: '2014-06-05',
        url: 'https://www.sec.gov/newsroom/speeches-statements/2014-spch060514mjw',
        evidence: 'Historical market-structure speech, not current Swiss rules',
        lesson: 'Low-latency trading depends on data and execution infrastructure as well as algorithms; rapid failures require technical controls.',
        limitation: 'No current infrastructure costs, measured Obolus latency or trading edge established.',
        application: 'Keep language-model research separate from deterministic execution; require measured latency tails, capacity, recovery and kill-switch tests.' },
      { id: 'microstructure', author: 'CME Group', date: null,
        url: 'https://www.cmegroup.com/education/articles-and-reports/understanding-the-cme-liquidity-tool-methodology',
        evidence: 'Exchange order-book methodology; current and pre-April-2024 methods distinguished',
        lesson: 'Measure spread and executable depth at order arrival. Top-of-book prices do not imply full-size fills.',
        limitation: 'Snapshots omit queue position and cancellations; daily OHLC cannot establish a scalping edge.',
        application: 'Scalping paper round trips reuse bounded depth fills, arrival timestamps and partial-exit exposure.' },
      { id: 'turnover', author: 'FINRA', date: null,
        url: 'https://www.finra.org/rules-guidance/rulebooks/finra-rules/2270',
        evidence: 'US day-trading risk disclosure, not Swiss legal authorization',
        lesson: 'Frequent round trips accumulate costs; trading frequency itself is not an economic advantage.',
        limitation: 'A risk disclosure supplies no profitable signal, audited trader ranking or applicable Swiss permission.',
        application: 'Every scalping scenario deducts both execution fees and specified other cash costs; unresolved inventory has no settled-profit claim.' },
      { id: 'leverage', author: 'CFTC', date: null,
        url: 'https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/understand_risks_of_virtual_currency.html',
        evidence: 'Regulator customer advisory',
        lesson: 'Leverage magnifies losses as well as gains. Small adverse moves can consume collateral; a stop does not guarantee its fill price.',
        limitation: 'No specific venue liquidation or margin formula and no Swiss legal approval.',
        application: 'Existing marginPath checks collateral, leverage, maintenance, borrow and gap loss. Never increase leverage or trade frequency solely to meet a profit target.' },
      { id: 'costs', author: 'Frazzini, Israel, Moskowitz / AQR', date: '2018-08-23',
        url: 'https://www.aqr.com/Insights/Research/Working-Paper/Trading-Costs',
        evidence: 'Institutional execution-data study',
        lesson: 'Measure implementation costs for the actual venue, instrument and size; stress uncertain costs.',
        limitation: 'Institutional equity execution costs are not retail crypto or options fees.',
        application: 'Existing frictionStress at 2x/3x; no imported fee or capital assumptions.' },
      { id: 'overfitting', author: 'Bailey, Lopez de Prado', date: '2014-07-31',
        url: 'https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf',
        evidence: 'Statistical methodology',
        lesson: 'Selection among many backtests inflates apparent performance; preserve failed trials and an untouched test period.',
        limitation: 'No deflated Sharpe or calibrated profit probability is computed here.',
        application: 'Existing preregistration, trial limits, protocol lock and chronological learning; report candidate count.' },
      { id: 'trend', author: 'Hurst, Ooi, Pedersen / AQR', date: '2017-10-31',
        url: 'https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing',
        evidence: 'Historical multi-market strategy reconstruction',
        lesson: 'Test trend hypotheses across markets and periods rather than extrapolating a single favorable episode.',
        limitation: 'Historical simulated performance does not validate Obolus variants or future returns.',
        application: 'Existing trend families remain hypotheses; no automatic preference or parameter change.' },
      { id: 'diversification', author: 'Ed Seykota', date: null,
        url: 'https://www.seykota.com/tribe/TSP/Diversify/index.htm',
        evidence: 'Trader-authored illustrative simulation; publication date unspecified',
        lesson: 'Evaluate aggregate drawdown and dependence before treating multiple strategies as diversification.',
        limitation: 'Illustrative simulation, not independently audited returns; correlations can change.',
        application: 'Report outcome concentration; portfolio correlation evidence remains separately required.' },
    ],
    curriculum: [
      {horizon:'minutes',status:'unverified-intraday-strategy',
        requirements:['Closed bars before signal; no same-bar close-to-open leakage','Trading sessions, missing intervals and clock consistency','Executable bid/ask, lot/tick sizes and all cash costs','Preregistered forward periods and comparison to cash/no-action'],
        available:'Generic chronological OHLC research; no calibrated minute-data delivery or intrabar execution validation.'},
      {horizon:'scalping',status:'snapshot-scenarios-only',
        requirements:['Order arrival and exit snapshots','Spread, depth, fees, adverse-selection and latency stress','Partial fill inventory and bounded exposure','Fresh sequential data; no hand-picked profitable round trips'],
        available:'Bounded cash-long taker roundtrip scenarios; not signal discovery or calibrated profitability.'},
      {horizon:'hft',status:'not-validated',
        requirements:['Licensed event feed, sequencing, clock quality and recovery','Venue matching/queue model including cancel and replace races','Measured end-to-end latency distribution and overload behavior','Deterministic execution outside LLM calls, independently tested stop/recovery','Data, connectivity and infrastructure cash costs versus slower alternatives'],
        available:'Knowledge and prerequisites only; no certified HFT feed, queue replay, execution engine or latency advantage.'},
      {horizon:'leveraged',status:'generic-paper-scenarios-only',
        requirements:['Venue contract, maintenance, funding and liquidation rules','Joint exposure and correlated shock tests','Gap losses beyond stops and collateral','Fixed risk limits; no target trade frequency or leverage escalation after losses'],
        available:'Existing linear isolated-margin path scenarios; no live venue approval.'},
    ],
    learning: 'Persist finalized comparable past tests via StrategySeriesStore; exclude overlapping/future evidence, pause failures, permit winners only fresh paper validation. Never rewrite a revealed holdout or relax risk limits. Do not mix daily OHLC outcomes, snapshot scenarios and HFT execution evidence. New research must record horizon, provenance, costs and actual capability limits.',
    limitations: 'Curated starting set, not all successful traders or proof of the most profitable method. Survivor bias and changing regimes remain. Further sources require review; no automatic web ingestion or model retraining.',
  };
}

/** Read-only, bounded retrieval. Source prose is context, never executable policy. */
export function literaturePage(offset: unknown = 0, limit: unknown = 10, topic?: unknown) {
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 ||
      !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 20 ||
      (topic !== undefined && (typeof topic !== 'string' || !literatureResearchAgenda().some(t=>t.topic===topic)))) {
    throw new Error('Invalid literature page');
  }
  const all=literatureOverviews().filter(b=>topic===undefined||b.topic===topic);
  const start=offset as number, size=limit as number;
  return {mode:'research-context-only',total:all.length,offset:start,
    nextOffset:start+size<all.length?start+size:null,books:all.slice(start,start+size),
    liveAuthorized:false,strategyValidated:false,modelRetrained:false};
}

/** Our proposed falsification tasks, not claims about methods proven by the books. */
export function literatureResearchAgenda() {
  return [
    {topic:'costs',test:'Compare active turnover with a low-cost benchmark and no action after fees, spread, funding and taxes where applicable.',counterEvidence:'A gross edge can disappear after costs.'},
    {topic:'allocation',test:'Stress joint drawdowns, unstable correlations, sizing error and rebalancing cost under fixed capital limits.',counterEvidence:'Diversification can fail; selected concentrated winners omit failures.'},
    {topic:'trend',test:'Preregister trend rules across fresh regimes; compare whipsaw losses and execution costs against no action.',counterEvidence:'A small number of winners may dominate; sideway markets can lose.'},
    {topic:'signals',test:'Fix signal definitions and timestamps before a chronological untouched holdout; retain every attempted variant.',counterEvidence:'Visual patterns and backtest selection can leak future information.'},
    {topic:'derivatives',test:'Require contract-specific payoff, assignment, settlement, Greeks, margin, gap and funding scenarios before a strategy test.',counterEvidence:'Frequent small wins can conceal nonlinear tail losses; a pricing model is not a trading edge.'},
    {topic:'execution',test:'Measure arrival spread, depth, partial fills, queue assumptions and latency tails on suitable event data.',counterEvidence:'Data-processing speed and daily bars do not demonstrate HFT execution.'},
    {topic:'events',test:'Use point-in-time releases and calendars; test delays, revised data and failed events.',counterEvidence:'Revised figures and completed deals introduce hindsight.'},
    {topic:'models',test:'Check model assumptions, numerical convergence and data leakage; compare a simple baseline on an untouched period.',counterEvidence:'Model complexity and LLM confidence do not establish predictive value.'},
    {topic:'rates',test:'Use current contract conventions and joint curve, basis, duration, convexity and liquidity stress.',counterEvidence:'Historical benchmarks and normal-rate assumptions may be obsolete.'},
    {topic:'credit',test:'Include defaults, recoveries, cash-flow timing, liquidity and counterparty concentration.',counterEvidence:'Yield and accounting valuation do not guarantee collected cash.'},
    {topic:'valuation',test:'Use point-in-time accounts and sensitivity ranges for cash flows, discount rates and terminal assumptions.',counterEvidence:'Reported metrics and precise-looking valuations may be biased.'},
    {topic:'regimes',test:'Separate discovery from fresh periods containing different volatility, liquidity and rate environments.',counterEvidence:'Historical narratives are not calibrated crisis forecasts.'},
    {topic:'selection',test:'Include failed and delisted candidates in the selection universe and compare against passive exposure.',counterEvidence:'Biographies, top-stock examples and testimonials have survivorship bias.'},
    {topic:'behaviour',test:'Keep immutable decision records and enforce stops independently of confidence or persuasive prose.',counterEvidence:'Discipline helps consistency but does not create a profitable signal.'},
    {topic:'measurement',test:'Reconcile settled cash and all losses; report drawdowns, benchmark and winner concentration separately.',counterEvidence:'Paper gains, cherry-picked episodes and gross returns are not realised profit.'},
    {topic:'operations',test:'Test stale data, failed reconciliation, duplicate events and missing permissions with fail-closed controls.',counterEvidence:'A sound strategy can fail through custody, data or operational errors.'},
  ].map(item=>({...item,status:'HOLD_UNVALIDATED',requires:'A separately preregistered test with suitable data and fixed cash-cost assumptions; no personnel costs, no risk-limit changes.'}));
}

/** Descriptive sensitivity, NOT a statistical test or a new permission gate.
 * Omitting a winner can penalize genuine trend strategies; it prompts analysis,
 * not automatic rejection. Losses remain in the calculation. */
export function outcomeSensitivity(outcomes: readonly number[]) {
  if (!Array.isArray(outcomes) || outcomes.length > 5000 || outcomes.some(n => !Number.isSafeInteger(n))) throw new Error('Invalid research outcomes');
  let total = 0, positive = 0, best = 0;
  for (const n of outcomes) {
    total += n;
    if (n > 0) positive += n;
    best = Math.max(best, n);
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(positive)) throw new Error('Research outcome sum overflow');
  }
  const withoutBest = total - best;
  if (!Number.isSafeInteger(withoutBest)) throw new Error('Research sensitivity overflow');
  return { netCents: total, bestPositiveOutcomeCents: best,
    bestShareOfPositiveOutcomes: positive ? best / positive : null,
    netWithoutBestPositiveOutcomeCents: withoutBest,
    positiveResultDependsOnBestOutcome: total > 0 && withoutBest <= 0,
    sampleSize: outcomes.length, statisticalProfitProbability: null,
    interpretation: 'Descriptive sensitivity only; outcomes may be dependent. Not a rule to discard concentrated trend returns or permission to trade.' };
}
