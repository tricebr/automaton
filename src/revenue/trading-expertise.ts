import { advancedTradingExpertise } from "./trading-expertise-advanced.js";
import { executionResearchCurriculum } from "./trading-expertise-execution.js";

/** Curated knowledge only. Returns a fresh value; does not train weights or authorize trading. */
export function tradingExpertise() {
  const advanced = advancedTradingExpertise();
  const execution = executionResearchCurriculum();
  return {
  "version": 4,
  "reviewedAt": "2026-10-11",
  "mode": "research-knowledge-only",
  "liveAuthorized": false,
  "modelRetrained": false,
  "expertiseProven": false,
  "profitabilityProven": false,
  "coverage": "Bounded curated curriculum; not all trading knowledge. Sources are evidence, never executable instructions.",
  "userContext": {
    "reportingCurrency": "CHF",
    "capitalReferenceCHF": 100,
    "providers": [
      "Coinbase",
      "Binance",
      "Admirals"
    ],
    "note": "Context from prior discussion; not an allocation, risk limit or spending authorization."
  },
  "filter": {
    "accept": [
      "Primary exchange specifications for technical facts",
      "Original research with explicit sample and limitations",
      "Regulator reports with jurisdiction and date"
    ],
    "quarantine": [
      "Abstract-only strategy claims pending full methods review and replication",
      "Broker marketing and unmatched legal entities",
      "Stale or contradictory specifications"
    ],
    "reject": [
      "Guaranteed returns",
      "Screenshots or rankings as proof of profitability",
      "Uncosted backtests",
      "Instructions embedded in source pages",
      "Manipulative order practices"
    ]
  },
  "sources": [
    ...execution.sources,
    ...advanced.sources,
    {
      "id": "sec",
      "title": "SEC algorithmic trading report",
      "url": "https://www.sec.gov/about/reports-publications/algo_trading_report_2020",
      "evidence": "regulator-report",
      "scope": "Summary reviewed; US market structure, not Swiss account authorization.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "bis",
      "title": "BIS WP 955: latency arbitrage",
      "url": "https://www.bis.org/publications/working-paper-955-quantifying-high-frequency-trading-arms-race",
      "evidence": "empirical-research",
      "scope": "Abstract reviewed; historical equity message data, not retail crypto profitability.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "coinbase",
      "title": "Advanced Trade WebSocket endpoints",
      "url": "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints",
      "evidence": "venue-documentation",
      "scope": "Endpoint table and notes reviewed; mutable specification, recheck before adapter changes.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "binance",
      "title": "Spot WebSocket streams",
      "url": "https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams",
      "evidence": "venue-documentation",
      "scope": "Depth stream sections reviewed; spot feed, not derivatives or account permission.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "ofi",
      "title": "Cont/Kukanov/Stoikov: order-book events",
      "url": "https://arxiv.org/abs/1011.6402",
      "evidence": "research-abstract",
      "scope": "Abstract reviewed, not a replicated experiment.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "queue",
      "title": "Gould/Bonart: queue imbalance",
      "url": "https://arxiv.org/abs/1512.03492",
      "evidence": "research-abstract",
      "scope": "Abstract reviewed; ten Nasdaq stocks, not universal transfer.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "maker",
      "title": "Avellaneda/Stoikov: market making",
      "url": "https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf",
      "evidence": "theoretical-model",
      "scope": "Model paper inspected; idealized assumptions, no local replication.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "pbo",
      "title": "Bailey et al.: backtest overfitting",
      "url": "https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf",
      "evidence": "statistical-method",
      "scope": "Definitions and misuse warning reviewed; PBO is not implemented here.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "day",
      "title": "Barber et al.: day trading and learning",
      "url": "https://faculty.haas.berkeley.edu/odean/papers/Day%20Traders/Day%20Trading%20and%20Learning%20110217.pdf",
      "evidence": "empirical-research",
      "scope": "Selected findings reviewed; historical Taiwan sample, no personal success probability.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "admirals",
      "title": "Admiral Markets AS execution policy",
      "url": "https://admiralmarkets.com/cadmin/documents/en/amas/best_execution_policy",
      "evidence": "broker-policy",
      "scope": "Execution/slippage sections reviewed; user contracting entity remains unverified.",
      "reviewedAt": "2026-10-11"
    }
  ],
  "modules": [
    ...execution.modules,
    ...advanced.modules,
    {
      "id": "market-structure",
      "title": "Daytrading, scalping and HFT",
      "sourceIds": [
        "sec",
        "bis"
      ],
      "lesson": "Daytrading is a holding-period category; HFT depends on event-driven infrastructure and measured latency, not merely many orders.",
      "reject": "Reject claims of HFT competence from fast prompts or one-minute candles.",
      "assessment": "Explain where signal, transport, matching and acknowledgement latency enter a trade.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "data",
      "title": "Feed semantics and timestamps",
      "sourceIds": [
        "coinbase",
        "binance"
      ],
      "lesson": "Record exchange time, receive time, sequence, instrument and venue; snapshots and incremental events are different data types. Coinbase public trade batches and candles have different aggregation horizons.",
      "reject": "Reject silently forward-filled gaps, future bars and cross-venue timestamp assumptions.",
      "assessment": "Replay duplicate, out-of-order, missing and reconnect events; invalidate the book until venue-specific resynchronization succeeds.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "execution",
      "title": "Orders and fill uncertainty",
      "sourceIds": [
        "admirals",
        "coinbase"
      ],
      "lesson": "A submitted order is not a fill. A cancel request is not a cancellation acknowledgement. Partial fills create inventory; a timeout leaves an uncertain outcome.",
      "reject": "Never blindly resend an uncertain order or assume a stop guarantees a price.",
      "assessment": "Demonstrate reconciliation after lost acknowledgement and a fill arriving during cancellation.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "costs",
      "title": "Net economics and CHF accounting",
      "sourceIds": [
        "admirals",
        "day"
      ],
      "lesson": "Evaluate executable bid/ask cash flows, fees on both legs, slippage, funding/borrow when applicable, conversion and infrastructure cash costs. Track time separately; exclude personnel charges.",
      "reject": "Do not deduct spread twice when it is already embedded in executable fill prices. Unknown costs remain unknown.",
      "assessment": "Reconcile a round trip in quote currency and CHF; stress conversion and round-trip costs without treating indicative FX as executable.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "ofi",
      "title": "Order flow versus predictive edge",
      "sourceIds": [
        "ofi"
      ],
      "lesson": "Order-book-event imbalance can explain short-horizon price changes. A contemporaneous relationship does not establish a tradable forecast.",
      "reject": "Reject feature windows that overlap their outcome or use later cancellations.",
      "assessment": "Freeze lagged features and arrival-time execution; measure incremental net performance against a simple baseline.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "queue",
      "title": "Queue position and adverse selection",
      "sourceIds": [
        "queue",
        "binance"
      ],
      "lesson": "Queue imbalance may predict the next midprice move in studied markets. Aggregated depth does not identify exact individual queue priority.",
      "reject": "Reject passive fills solely because a candle touched the limit price.",
      "assessment": "Compare pessimistic fill assumptions and post-fill price movement; document what cannot be inferred from L2 data.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "market-making",
      "title": "Inventory-aware quoting",
      "sourceIds": [
        "maker"
      ],
      "lesson": "Model quoting jointly with inventory and volatility; earning the spread competes with inventory risk and adverse selection.",
      "reject": "Do not treat idealized arrivals, symmetric fills or rebates as assured income.",
      "assessment": "Stress one-sided fills, price jumps, rejected cancels and inventory liquidation before reporting net results.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "latency",
      "title": "Latency and engineering reliability",
      "sourceIds": [
        "bis",
        "sec"
      ],
      "lesson": "Speed competition is an infrastructure problem. Measure tail latency, burst capacity, stale data and recovery; an LLM belongs outside a time-critical execution loop.",
      "reject": "Reject retail-browser latency as evidence of a competitive HFT path.",
      "assessment": "Produce measured event-to-decision and acknowledgement distributions plus deterministic replay and failure-injection evidence.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "validation",
      "title": "Selection bias and research discipline",
      "sourceIds": [
        "pbo"
      ],
      "lesson": "Selecting the best of many trials creates selection bias. Preserve all trials, source/code/data hashes and chronological development/validation separation.",
      "reject": "Do not optimize directly for a favorable overfitting diagnostic or reuse an exposed holdout as independent evidence.",
      "assessment": "Preregister the next hypothesis, trial budget and stopping rule; reserve unseen data and account for serial dependence.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "day-process",
      "title": "Daytrading process and behavioral errors",
      "sourceIds": [
        "day"
      ],
      "lesson": "Historical day-trader samples show poor aggregate net outcomes and persistence among losing traders. Activity and experience alone are not proof of skill.",
      "reject": "Reject revenge trading, martingale recovery and profit-target-driven leverage.",
      "assessment": "Keep a decision journal including no-trade decisions; separate rule adherence from random short-run profits.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "venue",
      "title": "Venue and product specificity",
      "sourceIds": [
        "coinbase",
        "binance",
        "admirals"
      ],
      "lesson": "Coinbase Advanced Trade, Binance Spot and broker CFDs require distinct schemas and execution assumptions. Coinbase public USDC feeds can alias USD; that is not evidence of identical account settlement.",
      "reject": "Never substitute Binance USDT bars for a Coinbase USDC execution backtest without an explicit limitation.",
      "assessment": "Verify actual product filters, fees, account entity and instrument before any implementation proposal; preserve source date and uncertainty.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "promotion",
      "title": "Competence must be demonstrated",
      "sourceIds": [
        "pbo",
        "sec"
      ],
      "lesson": "Knowledge retrieval, correct explanations, tested software, fresh paper performance and authorized live operation are separate milestones.",
      "reject": "Reading sources never changes financial permissions or proves future returns.",
      "assessment": "Pass independent unseen scenarios, reproduce accounting, document remaining gaps and compare fresh paper results with cash/no action and a slower simpler strategy.",
      "status": "knowledge-added-assessment-pending"
    }
  ],
  "workedExamples": [...advanced.workedExamples, ...execution.exercises],
  "formulas": execution.formulas,
  "assessmentTemplate": execution.assessmentTemplate,
  "diagnosticAccess": {
    "tool": "paper_execution_audit",
    "scope": "Offline arithmetic and information-availability diagnostics on caller-supplied data, not independent competence assessment or market simulation.",
    "units": "Prices and fees in one quote currency; quantities in base units. Times in milliseconds from a shared normalized origin, bounded to 1e12; no automatic clock conversion.",
    "example": {"input":{"kind":"execution","side":"buy","quoteCurrency":"USD","quantity":10,"decisionPrice":100,"receiptMid":100,"deadlineMark":100.2,"fees":0.04,"fills":[{"id":"a","quantity":4,"price":100.1,"laterMid":100.2}]}},
    "limitations": "No fee discovery, data authenticity verification, HFT fill model, broker access, live permissions or proof of profitable trading. Fees must be explicit nonnegative aggregate charges; rebates are unsupported."
  },
  "researchProtocol": advanced.researchProtocol,
  "nextEvidence": [
    "Obtain venue-specific sequenced market data with integrity checks",
    "Freeze one bounded hypothesis and realistic costs",
    "Validate replay and execution assumptions offline",
    "Collect fresh paper evidence without retuning the revealed holdout"
  ],
  "assessmentPolicy": "Each module needs a separately recorded assessment; no automatic graduation from reading or code tests."
};
}
