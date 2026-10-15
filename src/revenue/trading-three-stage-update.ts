/** Research observations, not authorization or a calibrated trading edge. */
export function tradingThreeStageUpdate() {
  return {
    version: 1, reviewedAt: '2026-10-11', liveAuthorized: false, profitabilityProven: false,
    artifact: 'artifacts/trading-three-stage-20261011/completion.json',
    fractionalComparison: {
      reports: 78, matchedPriorSelectionReports: 78, reusedHistoricalData: true,
      parametersRetuned: false, hypotheticalLotRules: true,
      smallAccountQuoteUnits: 100, quoteCurrency: 'USDT',
      selectorResults: [
        { symbol: 'BTCUSDT', netCents: 127, trades: 1, doubledCostNetCents: 81, tripledCostNetCents: 54 },
        { symbol: 'ETHUSDT', netCents: 0, trades: 0, doubledCostNetCents: 0, tripledCostNetCents: 0 },
        { symbol: 'SOLUSDT', netCents: 6, trades: 1, doubledCostNetCents: -15, tripledCostNetCents: -28 },
      ],
      interpretation: 'Fractional training can change which fixed candidates are eligible. With the original whole-unit training selections frozen, all three small-account selectors still make no trades. The fractional training result and pure execution-model change are separate comparisons. One profitable BTC trade is not independent evidence of an edge.',
    },
    eventDiagnostic: {
      syntheticCases: 7, decisionsCommittedBeforeOutcomeRead: true,
      independentBlindAssessment: false, realNewsReplayCompleted: false,
      lesson: 'Six inconsistent or unsupported scenarios were rejected. One unique event passed only the hypothetical paper-review rules and its synthetic outcome was a loss. Judge decision evidence separately from outcome. No probability calibration or real-event trading skill established.',
    },
    freshPaperProtocol: {
      durationSeconds: 300, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], liveOrders: false,
      interval: '15m', selection: 'Fixed candidates, preceding completed candles, same training eligibility rules',
      interpretation: 'Operational observation only. First entry uses a newly observed quote between candle boundaries, not a historical candle-open fill. Displayed size does not guarantee a fill. Public bookTicker lacks an exchange timestamp. Open positions are marked separately from realized results. See completion artifact for actual observation and errors; five minutes cannot validate profitability.',
    },
    nextEvidence: 'A longer prospectively frozen paper sample, timestamped real-news decisions and executable market data are still required. Do not turn the best reused-sample result into a live authorization.',
  };
}
