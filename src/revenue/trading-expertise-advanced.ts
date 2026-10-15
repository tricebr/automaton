/** Reviewed research and original exercises; no execution, model training or permissions. */
export function advancedTradingExpertise() {
  return {
  "version": 1,
  "reviewedAt": "2026-10-11",
  "sources": [
    {
      "id": "cme-mbo",
      "title": "CME: Market by Order",
      "url": "https://www.cmegroup.com/articles/faqs/market-by-order-mbo.html",
      "evidence": "venue-documentation",
      "scope": "FAQ including MBP/MBO and priority identifiers reviewed; historical CME-specific specification, not a crypto queue guarantee.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "ouch",
      "title": "Nasdaq OUCH 5.0",
      "url": "https://nasdaqtrader.com/content/technicalsupport/specifications/TradingProducts/Ouch5.0.pdf",
      "evidence": "venue-documentation",
      "scope": "Cancel Pending and Cancel Reject sections inspected; special cross-order semantics, not a universal order-state specification.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "dsr",
      "title": "Bailey/Lopez de Prado: Deflated Sharpe Ratio",
      "url": "https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf",
      "evidence": "statistical-method",
      "scope": "Multiple trials, PSR/DSR inputs and assumptions reviewed; no estimator implemented or empirically validated here.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "queue-reactive",
      "title": "Huang/Lehalle/Rosenbaum: queue-reactive model",
      "url": "https://arxiv.org/html/1312.0563",
      "evidence": "research-method",
      "scope": "State-dependent queue model and execution-probability comparison inspected; not locally calibrated.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "filters",
      "title": "Binance Spot filters",
      "url": "https://developers.binance.com/en/docs/products/spot/filters",
      "evidence": "venue-documentation",
      "scope": "Price, lot size and notional sections reviewed; actual instrument/account values must be obtained separately.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "stop-orders",
      "title": "FINRA: Stop Orders",
      "url": "https://www.finra.org/investors/insights/stop-orders-factors-consider-during-volatile-markets",
      "evidence": "regulator-education",
      "scope": "2025 investor article and execution-price discussion reviewed; US stocks, not an assertion of Swiss legal applicability.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "apac",
      "title": "Market intraday momentum: APAC evidence",
      "url": "https://researchmgt.monash.edu/ws/files/519509174/494419119_oa.pdf",
      "evidence": "empirical-research",
      "scope": "Abstract and introduction inspected; market heterogeneity and crisis limitation, no independent replication.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "deeplob",
      "title": "Zhang/Zohren/Roberts: DeepLOB",
      "url": "https://www.oxford-man.ox.ac.uk/wp-content/uploads/2020/03/DeepLOB-Deep-Convolutional-Neural-Networks-for-Limit-Order-Books.pdf",
      "evidence": "research-method",
      "scope": "Data normalization, chronological split, labels and simulation limitations inspected; no model trained.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "fed-information",
      "title": "Huh: Machines vs. Machines",
      "url": "https://www.federalreserve.gov/econres/feds/machines-vs-machines-high-frequency-trading-and-hard-information.htm",
      "evidence": "research-abstract",
      "scope": "Abstract reviewed; information asymmetry and liquidity provision during stress, not a universal causal law.",
      "reviewedAt": "2026-10-11"
    }
  ],
  "modules": [
    {
      "id": "intraday-transfer",
      "title": "Intraday momentum and regime dependence",
      "sourceIds": [
        "apac"
      ],
      "lesson": "The studied APAC ETFs show heterogeneous intraday momentum: stronger evidence in China and Japan, weak in Korea, none in Hong Kong and Singapore; crisis-period effects weaken.",
      "reject": "Do not transfer a US equity session rule to round-the-clock crypto or pick only favorable markets.",
      "assessment": "Freeze session boundaries, daylight-saving handling, opening-return definition and entry time; test each market and stress period separately.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "stop-gap",
      "title": "Stops, gaps and intrabar ambiguity",
      "sourceIds": [
        "stop-orders"
      ],
      "lesson": "A triggered stop can execute far from its trigger; a stop-limit can remain unfilled. Our research procedure must model both price uncertainty and non-execution.",
      "reject": "Do not bound worst-case loss by stop distance or invent which of two touched OHLC levels occurred first.",
      "assessment": "For a bar touching both stop and target, report ambiguity or use sequenced events; stress a gap through the stop and an unfilled limit.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "mbo-priority",
      "title": "Order-level data and matching priority",
      "sourceIds": [
        "cme-mbo"
      ],
      "lesson": "CME MBO exposes anonymous individual orders and priority identifiers; aggregated MBP cannot establish precise individual queue position. This distinction is venue-specific.",
      "reject": "Do not infer participant identity, hidden size or another venue matching rule from this feed.",
      "assessment": "Explain what a priority change and synthetic iceberg refresh do to a reconstructed queue; list observations missing from L2 crypto data.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "queue-simulation",
      "title": "State-dependent execution models",
      "sourceIds": [
        "queue-reactive"
      ],
      "lesson": "The queue-reactive paper models order arrivals conditional on book state and price-regime changes; its comparison finds a simpler Poisson model overstates execution probability.",
      "reject": "Do not equate matching stylized facts with accurate fills for our orders.",
      "assessment": "Calibrate only on training events, then compare fill probability and time-to-fill against unseen events, including cancelled and unfilled orders.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "cancel-cross",
      "title": "Protocol-specific cancellation states",
      "sourceIds": [
        "ouch"
      ],
      "lesson": "OUCH Cancel Pending for a cross order in the pre-cross late period defers cancellation of the unexecuted portion until after the cross. Cancel Reject has different consequences.",
      "reject": "Do not treat pending as cancelled or reuse this special Nasdaq state diagram as a Coinbase protocol.",
      "assessment": "Replay a cross fill after Cancel Pending and reconcile executed and remaining quantity; distinguish a rejected partial cancel.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "discrete-sizing",
      "title": "Ticks, lots and minimum notional",
      "sourceIds": [
        "filters"
      ],
      "lesson": "Spot price increments, quantity steps and notional bounds are separate constraints. Venue rules include order-type-specific filters and changing reference prices.",
      "reject": "Do not use floating-point decimal formatting as tick validation or round up beyond a research risk budget.",
      "assessment": "With synthetic price 100 and step 0.01, show why a 5-unit quote budget cannot satisfy a minimum notional of 10; reject rather than enlarge.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "multiple-trials",
      "title": "Deflated Sharpe and trial accounting",
      "sourceIds": [
        "dsr"
      ],
      "lesson": "DSR addresses selection and non-normal returns using sample length, skewness, kurtosis, trial dispersion and effective independent trial count. Input uncertainty remains material.",
      "reject": "Do not report a favorable Sharpe from one selected run while hiding parameter, feature and universe searches.",
      "assessment": "Preserve the complete experiment registry, explain correlated trials and sensitivity to effective count; do not label DSR a probability of future profit.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "deep-labels",
      "title": "LOB learning without leakage",
      "sourceIds": [
        "deeplob"
      ],
      "lesson": "DeepLOB uses chronological data splits and prior-day normalization. Its illustrative PnL simulation uses mid-prices and omits transaction costs; predictive accuracy alone is insufficient.",
      "reject": "Do not use future-smoothed labels as executable exits or normalize features using future observations.",
      "assessment": "Audit every feature and label timestamp, compare a simple baseline, and replace illustrative prices with delayed executable prices before a net-profit claim.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "stress-liquidity",
      "title": "Information asymmetry and liquidity withdrawal",
      "sourceIds": [
        "fed-information"
      ],
      "lesson": "The cited research links faster access to machine-readable information with weaker liquidity provision, especially in volatile conditions. Stress scenarios must allow depth to disappear.",
      "reject": "Do not simulate volatility jumps while keeping normal depth, spreads and latency fixed.",
      "assessment": "Jointly stress thinner depth, wider spreads, delayed cancellation and one-sided fills; state explicitly that the scenario is our design, not a fitted result.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "markout",
      "title": "Fill-conditioned evaluation",
      "sourceIds": [
        "queue-reactive",
        "maker"
      ],
      "lesson": "Our synthesis: evaluate passive orders jointly by fill probability and conditional post-fill value. A high fill rate can select the trades with the worst subsequent price movement.",
      "reject": "Do not multiply unconditional alpha by an unrelated fill probability or omit inventory liquidation.",
      "assessment": "Report signed markouts at predefined horizons for filled orders, unfilled opportunity cost, fees and inventory PnL separately.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "day-hypotheses",
      "title": "A falsifiable daytrading research menu",
      "sourceIds": [
        "apac",
        "pbo"
      ],
      "lesson": "Our research candidates are session momentum, opening-range breakout and volatility-conditioned mean reversion. These are hypotheses, not source-endorsed profitable recommendations.",
      "reject": "Do not tune entry, exit, universe and regime filters on the final holdout or reverse losing signals after viewing it.",
      "assessment": "Define one candidate with fixed lookback, information cutoff, entry/exit, costs, no-trade conditions and rejection threshold before any fresh paper run.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "hft-gate",
      "title": "HFT feasibility before model complexity",
      "sourceIds": [
        "bis",
        "cme-mbo",
        "deeplob"
      ],
      "lesson": "Our synthesis: the needed data, matching semantics, tail latency and realistic fill economics must be demonstrated before choosing complex HFT models. Faster predictions do not establish faster executable decisions.",
      "reject": "Do not buy infrastructure or promote a paper model from a latency average or a source paper result.",
      "assessment": "Produce a feasibility sheet listing measured versus unknown data resolution, p99 latency, fees, fill model and capital constraints; unknown essentials keep deployment unqualified.",
      "status": "knowledge-added-assessment-pending"
    }
  ],
  "workedExamples": [
    {
      "id": "cost-round-trip",
      "kind": "synthetic-worked-example",
      "prompt": "Buy 0.05 units at 100.00, sell at 100.10; quote-currency fee 0.1% on each leg. No other costs. Net PnL?",
      "answer": "Gross 0.005; fees 0.005 + 0.005005 = 0.010005; net -0.005005 quote units. Spread is already in the given executable prices.",
      "expectedNet": -0.005005
    },
    {
      "id": "fill-selection",
      "kind": "synthetic-worked-example",
      "prompt": "A passive order fills with probability 0.4. Conditional gross PnL if filled is -0.03 and fees are 0.01. Unfilled PnL is zero. Expected PnL?",
      "answer": "0.4 * (-0.03 - 0.01) = -0.016. This simplified one-order example excludes inventory interactions and opportunity cost.",
      "expectedNet": -0.016
    },
    {
      "id": "cancel-race",
      "kind": "synthetic-worked-example",
      "prompt": "Order quantity 10: fill 3, request cancel, fill 2, acknowledgement cancels the remaining 5. Final execution?",
      "answer": "Executed quantity 5, cancelled quantity 5. The request did not remove exposure; de-duplicate execution IDs and reconcile final authoritative state."
    },
    {
      "id": "holdout-contamination",
      "kind": "synthetic-worked-example",
      "prompt": "The best of 40 variants loses on the test set. After seeing it, tighten the stop and rerun. Is the second result independent?",
      "answer": "No. The revealed test set is now development evidence. Register the additional trial and reserve genuinely unseen future data."
    },
    {
      "id": "bar-ordering",
      "kind": "synthetic-worked-example",
      "prompt": "After entry, one OHLC bar spans both stop and profit target. Can the profitable exit be recorded?",
      "answer": "No unique event ordering is known. Use finer sequenced data or disclose conservative scenario bounds; do not silently choose the target."
    },
    {
      "id": "accuracy-economics",
      "kind": "synthetic-worked-example",
      "prompt": "Direction accuracy is 60%, equal gross wins/losses of 1 basis point, round-trip cost 2 basis points. Net expectation?",
      "answer": "0.6*1 - 0.4*1 - 2 = -1.8 basis points. Accuracy can coexist with negative economic value.",
      "expectedNet": -1.8
    }
  ],
  "researchProtocol": {
    "purpose": "Author-created synthesis for education and future paper research; not an executed experiment.",
    "stages": [
      "Record a falsifiable economic mechanism and failure conditions.",
      "Freeze instrument, session, dataset, feature availability, horizon and complete trial registry.",
      "Validate event ordering, gaps, duplicates, corporate actions where relevant and instrument units.",
      "Use chronological splits; prevent overlapping outcome windows from crossing boundaries and fit transformations on past training data only.",
      "Simulate arrival delay, partial fills, rejected orders, queue uncertainty and liquidation; reconcile all cash flows.",
      "Compare no action and a simpler slower baseline using net outcomes and dependence-aware uncertainty.",
      "Stress costs, missing data and joint liquidity/latency shocks without selecting a favorable stress definition afterward.",
      "Reserve fresh paper evidence and record failed hypotheses. Human authorization is separate from all research gates."
    ],
    "reportFields": [
      "hypothesis",
      "venue/product",
      "data provenance and hashes",
      "information availability times",
      "all trials including failures",
      "gross/net cash reconciliation",
      "turnover and exposure",
      "drawdown and tail scenarios",
      "fill probability and markouts",
      "latency distributions",
      "unseen interval",
      "uncertainty and unresolved assumptions"
    ],
    "competencePolicy": "Worked answers are teaching material, not independent exams. No module passes automatically. An evaluator must create unseen variants, record answers and reasoning, and explicitly distinguish arithmetic correctness, protocol knowledge, strategy evidence and live permissions."
  }
};
}
