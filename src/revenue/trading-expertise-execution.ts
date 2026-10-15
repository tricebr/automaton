/** Research synthesis and teaching cases, not a simulator or trading authority. */
export function executionResearchCurriculum() {
  return {
  "sources": [
    {
      "id": "execution-quality",
      "title": "SEC Rule 605 FAQ (April 2026)",
      "url": "https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/frequently-asked-questions-rule-605-regulation-nms",
      "evidence": "regulator-guidance",
      "scope": "Examples 27-1 and Q33/Q37 reviewed. US reporting context; educational metrics below are not a compliant Rule 605 report.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "matching",
      "title": "CME agricultural market matching overview",
      "url": "https://www.cmegroup.com/education/articles-and-reports/overview-what-makes-ags-markets-work",
      "evidence": "venue-documentation",
      "scope": "FIFO and hybrid allocation sections read. Historical product mappings are not asserted current; verify instrument specifications.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "optimal-execution",
      "title": "Almgren/Chriss: Optimal Execution of Portfolio Transactions",
      "url": "https://smallake.kr/wp-content/uploads/2016/03/optliq.pdf",
      "evidence": "theoretical-model",
      "scope": "Original December 2000 paper on a third-party mirror; model, temporary/permanent impact and independence assumptions inspected. Author-host link unavailable; no replication.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "sharpe-dependence",
      "title": "Lo: Statistics of Sharpe Ratios and limit-order execution abstracts",
      "url": "https://alo.mit.edu/publications/page/18/",
      "evidence": "author-abstracts",
      "scope": "Two 2002 paper abstracts on author website reviewed; no full-paper derivation or coefficient calibration claimed.",
      "reviewedAt": "2026-10-11"
    },
    {
      "id": "abides",
      "title": "ABIDES: Towards High-Fidelity Market Simulation for AI Research",
      "url": "https://arxiv.org/html/1904.12066",
      "evidence": "research-method",
      "scope": "Discrete-event kernel, latency and deterministic random execution sections inspected. No external simulator installed or executed.",
      "reviewedAt": "2026-10-11"
    }
  ],
  "modules": [
    {
      "id": "spread-accounting",
      "title": "Execution-quality measures and sign conventions",
      "sourceIds": [
        "execution-quality"
      ],
      "lesson": "Measure each partial fill against a specified receipt-time midpoint; aggregate with executed quantity weights. Realized spreads use a later benchmark. These diagnostics are not the same as net strategy PnL.",
      "reject": "Do not use an unweighted average of fills or silently change benchmark timestamps.",
      "assessment": "Compute buy and sell examples, partial-fill weights and the effect of changing the later midpoint; explain why favorable execution need not mean a profitable strategy.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "impact-risk",
      "title": "Execution scheduling versus directional forecasting",
      "sourceIds": [
        "optimal-execution"
      ],
      "lesson": "The model balances expected execution cost with inventory price risk and distinguishes temporary from persistent impact under explicit assumptions. Optimizing a liquidation schedule does not establish directional alpha.",
      "reject": "Do not transplant model coefficients between assets or assume impact is zero because historical replay prices are fixed.",
      "assessment": "Compare fast and slow hypothetical liquidation under identical starting inventory, deadline, fees and volatility; explain where model assumptions fail during liquidity shocks.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "matching-rules",
      "title": "FIFO, pro-rata and hybrid matching",
      "sourceIds": [
        "matching"
      ],
      "lesson": "Time priority and size-based allocation imply different fill behavior. Actual hybrid rules include product-specific details; a simple pro-rata toy example is not an exchange implementation.",
      "reject": "Do not increase order size to chase simulated allocation without accounting for the resulting potential inventory.",
      "assessment": "For the same incoming quantity, compare FIFO with an ideal proportional allocation and identify missing rounding, minimum allocation and priority rules.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "dependent-returns",
      "title": "Dependence and uncertainty in daytrading metrics",
      "sourceIds": [
        "sharpe-dependence"
      ],
      "lesson": "Serial correlation changes return aggregation and the interpretation of Sharpe. Treating thousands of correlated trades as independent observations can overstate precision.",
      "reject": "Do not annualize event-time Sharpe with an arbitrary trades-per-year multiplier.",
      "assessment": "Aggregate marked-to-market equity on a fixed clock, separate deposits from returns and explain dependence-aware uncertainty; disclose the limited number of distinct market days.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "censored-fills",
      "title": "Unfilled orders are data",
      "sourceIds": [
        "sharpe-dependence"
      ],
      "lesson": "Execution-time research distinguishes first fill and full completion; observed transactions are poor substitutes for actual limit-order outcomes. Our synthesis: retain unfilled and cancelled orders as outcomes, not missing successes.",
      "reject": "Do not estimate completion time using only orders that completed.",
      "assessment": "Design an order record including submission, first fill, each partial fill, cancellation, observation end and remaining size; explain censoring and selective cancellation.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "counterfactual-sim",
      "title": "Replay versus interactive simulation",
      "sourceIds": [
        "abides",
        "optimal-execution"
      ],
      "lesson": "ABIDES supports configurable communication delays and repeatable seeded runs. Our synthesis distinguishes historical replay, which fixes external events, from interactive markets that react to orders. Neither validates its own realism.",
      "reject": "Do not call deterministic reproduction empirical validation or assume simulated agents represent real competitors.",
      "assessment": "Hold seeds and configuration fixed for controlled comparisons; vary seeds for uncertainty and compare unseen spread, depth, event and fill distributions to actual data.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "latency-causality",
      "title": "Availability time and tail latency",
      "sourceIds": [
        "abides",
        "execution-quality"
      ],
      "lesson": "Our synthesis: a strategy can only consume an event after receipt and processing. Arrival at an exchange, matching, acknowledgements and local inventory updates are distinct times.",
      "reject": "Do not backdate an order to the signal exchange timestamp or use a mean delay to represent the tail.",
      "assessment": "Trace one event through all clocks, record units and clock uncertainty, and reject an apparent edge that expires before order arrival.",
      "status": "knowledge-added-assessment-pending"
    },
    {
      "id": "day-review",
      "title": "End-of-session accounting and evidence review",
      "sourceIds": [
        "execution-quality",
        "sharpe-dependence"
      ],
      "lesson": "Our synthesis: reconcile realized cash, open inventory at a stated liquidation mark, fees and external cash flows before evaluating a session. Count rule adherence separately from profit.",
      "reject": "Do not hide open losing positions, reset drawdown through deposits or report only profitable sessions.",
      "assessment": "Reconcile a session with a deposit, partial exit and remaining inventory; identify which gains are realized and which depend on the marking convention.",
      "status": "knowledge-added-assessment-pending"
    }
  ],
  "formulas": [
    {
      "id": "spreads",
      "sourceIds": [
        "execution-quality"
      ],
      "definition": "For side s=+1 buy/-1 sell, fill p, receipt midpoint m0 and later midpoint mh: effective spread=2*s*(p-m0); realized spread=2*s*(p-mh); signed midpoint movement=2*s*(mh-m0). Effective = realized + movement.",
      "limits": "Educational per-unit quote-currency quantities; fixed chosen horizon, no fees. Basis points require an explicit denominator. No claim of full regulatory-report compliance."
    },
    {
      "id": "shortfall",
      "sourceIds": [
        "optimal-execution"
      ],
      "definition": "Our fixed-deadline benchmark: side s=+1 buy/-1 sell, intended quantity Q, decision price p0, fills (qi,pi), unfilled U=Q-sum(qi), deadline mark pT, fees F: shortfall=s*sum(qi*(pi-p0))+s*U*(pT-p0)+F.",
      "limits": "Original teaching convention includes opportunity cost for unfilled quantity; this is not a cash debit, PnL or an obligatory completion instruction. Same currency and units required."
    },
    {
      "id": "return-aggregation",
      "sourceIds": [
        "sharpe-dependence"
      ],
      "definition": "Mathematical identity for a weakly stationary return sequence: Var(sum of n returns)=n*gamma(0)+2*sum from k=1 to n-1 of (n-k)*gamma(k).",
      "limits": "Requires finite second moments and stationarity; covariance estimates are uncertain. Not a fitted market model or future risk guarantee."
    }
  ],
  "exercises": [
    {
      "id": "buy-spreads",
      "kind": "synthetic-worked-example",
      "prompt": "Buy at 100.02, receipt midpoint 100.00, later midpoint 100.03. Effective and realized spread?",
      "answer": "Effective 0.04, realized -0.02, signed midpoint movement 0.06 quote units per unit. 0.04 = -0.02 + 0.06. These are doubled spread metrics, not the buyer net PnL."
    },
    {
      "id": "sell-spreads",
      "kind": "synthetic-worked-example",
      "prompt": "Sell at 99.98, receipt midpoint 100.00, later midpoint 99.97. Same metrics?",
      "answer": "With s=-1: effective 0.04, realized -0.02, movement 0.06. Using the buy sign would reverse the interpretation."
    },
    {
      "id": "weighted-fills",
      "kind": "synthetic-worked-example",
      "prompt": "Buy fills: quantity 1 at 100.01 and quantity 9 at 100.03, receipt midpoint 100.00. Average effective spread?",
      "answer": "(1*0.02+9*0.06)/10 = 0.056 per unit; not the unweighted 0.04."
    },
    {
      "id": "unfilled-shortfall",
      "kind": "synthetic-worked-example",
      "prompt": "Intend to buy 10 at benchmark 100; buy 4 at 100.10; 6 remain unfilled at deadline mark 100.20; fees 0.04. Shortfall under the stated convention?",
      "answer": "Executed cost 0.4 plus opportunity cost 1.2 plus fees 0.04 = 1.64. Actual cash spent is 400.44. Opportunity cost is not a paid fee."
    },
    {
      "id": "matching-toy",
      "kind": "synthetic-worked-example",
      "prompt": "Two resting orders A=6 then B=4 at one price; incoming sell=5. Allocate in pure FIFO and ideal fractional pro-rata.",
      "answer": "FIFO: A=5,B=0. Ideal proportional: A=3,B=2. Real product rules may add rounding, priority and minima; this toy does not establish actual fills."
    },
    {
      "id": "dependence-toy",
      "kind": "synthetic-worked-example",
      "prompt": "Two stationary returns each have variance 1 and covariance 0.5. Variance and standard deviation of their sum?",
      "answer": "Variance=1+1+2*0.5=3; standard deviation=sqrt(3), not sqrt(2). Independence-based scaling understates dispersion here."
    },
    {
      "id": "late-signal",
      "kind": "synthetic-worked-example",
      "prompt": "Event at 0ms, received at 80ms, compute 10ms, outbound 40ms. Apparent opportunity lasts 100ms from event time. Can the event-time backtest fill be accepted?",
      "answer": "Earliest modeled arrival is 130ms, after the opportunity. Reject the assumed fill; actual matching and acknowledgement can add further delay."
    },
    {
      "id": "session-equity",
      "kind": "synthetic-worked-example",
      "prompt": "Initial cash 100, external deposit 20, buy 1 at 10, sell 0.4 at 11, total paid fees 0.1, remaining 0.6 marked at executable bid 9. Session PnL?",
      "answer": "Cash=114.3; inventory=5.4; equity=119.7; flow-adjusted PnL=119.7-100-20=-0.3. Future liquidation fees remain additional unless already included."
    }
  ],
  "assessmentTemplate": {
    "status": "not-administered",
    "scope": "Independent human or isolated evaluator must supply unseen variants; these public teaching cases are not an exam.",
    "requiredEvidence": [
      "question and withheld rubric identity",
      "answer before feedback",
      "source and assumption justification",
      "arithmetic and unit checks",
      "counterexample or failure case",
      "reviewer decision and remaining gaps"
    ],
    "blockingErrors": [
      "future information used as available data",
      "unfilled orders silently dropped",
      "wrong buy/sell sign",
      "fees or external cash flow omitted",
      "research mistaken for trading authorization"
    ],
    "graduation": "No automatic expertise score or promotion. Passing arithmetic is not passing execution engineering or validating a strategy."
  }
};
}
