/** Shared TypeScript types for Options Dashboard (Phase 3). */

export {};

declare global {
  interface PnlStats {
    mean: number;
    median: number;
    p5: number;
    p25: number;
    p75: number;
    p95: number;
    min: number;
    max: number;
    prob_profit: number;
  }

  interface Histogram {
    counts: number[];
    edges: number[];
  }

  interface ThetaGroup {
    label: string;
    color: string;
    daily: number[];
    expiry: string;
  }

  interface ThetaMilestone {
    date: string;
    index: number;
    value: number;
  }

  interface ThetaData {
    dates: string[];
    groups: ThetaGroup[];
    totalDaily: number[];
    cumulative: number[];
    cumulativeNet: number[];
    milestones: ThetaMilestone[];
    todayTheta: number;
    todayEarned: number;
    todayCost: number;
    totalCumulative: number;
    totalCumulativeNet: number;
    nextExpiry?: string | null;
    postNextTheta: number;
  }

  interface TickerSimStats extends PnlStats {
    model?: string;
    reason?: string;
    price?: number;
    iv?: number;
  }

  interface CorrelationInfo {
    tickers: string[];
    matrix: number[][];
  }

  interface SimulateResult {
    n_paths: number;
    portfolio: PnlStats;
    by_ticker: Record<string, TickerSimStats>;
    by_strategy: Record<string, PnlStats>;
    histogram: Histogram;
    portfolio_pnl: number[];
    ticker_histograms: Record<string, Histogram>;
    ticker_paths: Record<string, Record<string, unknown>>;
    theta?: ThetaData | null;
    correlation?: CorrelationInfo | null;
    error?: string;
  }

  interface AlertThresholds {
    dteHigh: number;
    dteMedium: number;
    ivRank: number;
    exDivDays: number;
    portfolioPProfit: number;
    tickerPProfit: number;
    marksStaleMin: number;
    bookDeltaAbs: number;
    bookVegaAbs: number;
    tickerDeltaAbs: number;
    bookThetaBelow: number;
  }

  interface AppState {
    posText: string | null;
    histText: string | null;
    rawPosTexts: string[] | null;
    rawHistTexts: string[] | null;
    marketData: Record<string, Record<string, unknown>> | null;
    portfolio: Record<string, unknown> | null;
    positions: PositionRow[];
    fills: Record<string, unknown>[];
    format: string;
    simDone: boolean;
    simResult: SimulateResult | null;
    multiFile: boolean;
    viewMode: string;
    greeks: Record<string, unknown> | null;
    events: Record<string, unknown> | null;
    tradeHistory: Record<string, unknown> | null;
    prevSnapshot: Record<string, unknown> | null;
    fetchedAt: string | null;
    optionMarks: Record<string, unknown> | null;
    marksFetchedAt: string | null;
    marksNote: string | null;
    riskMatrixLoaded: boolean;
    simMeta: Record<string, unknown> | null;
    attribution: Record<string, unknown> | null;
    hypothetical: Record<string, unknown>[];
    whatifEditIndex: number | null;
    wiChainCache: Record<string, unknown>;
    lastRiskMatrix: Record<string, unknown> | null;
    deskAlerts: Record<string, unknown>[];
    alertHistory: Record<string, unknown>[];
    dismissedAlertKeys: string[];
    alertThresholds: AlertThresholds;
    alertNotifyOnFetch: boolean;
    lastAlertNotifyBatch: string | null;
    journalSort: { col: string; dir: string };
    journalFilter: string;
    journalStrategyFilter: string;
    journalDateFilter: string;
    journalShowAssignmentLegs: boolean;
    simCollapseState: Record<string, boolean>;
    simFocusTicker: string | null;
    simScrollY: number;
    simPProfitView?: "book" | "slices";
    autoRefresh: { enabled: boolean; intervalMin: number };
    pnlHistRange?: string;
    pnlHistCustom?: { lo: number; hi: number } | null;
    wiStrikeRows?: Record<string, unknown>[];
  }

  interface TickerPathData {
    model?: string;
    shares?: number;
    adjCost?: number;
    dates?: string[];
    p5?: number[];
    p95?: number[];
    p75?: number[];
    p25?: number[];
    p50?: number[];
    mean?: number[];
    strikes?: Array<{ strike: number; label: string; isEquity?: boolean; lineType?: string; [k: string]: unknown }>;
    breakevens?: Array<{ value: number; label: string; beType?: string; [k: string]: unknown }>;
    [key: string]: unknown;
  }

  interface WhatIfGreeksResult {
    delta: number;
    theta: number;
    vega: number;
    portfolio?: PnlStats;
    [key: string]: unknown;
  }

  interface AttributionData {
    byTicker?: Record<string, { pricePnl: number; thetaPnl: number; vegaPnl: number; total: number }>;
    total?: number;
    [key: string]: unknown;
  }

  interface PositionRow {
    ticker: string;
    posType?: string;
    optType?: string;
    strike?: number;
    expiry?: Date | string | null;
    contracts?: number;
    shares?: number;
    avgCost?: number;
    adjCost?: number | null;
    [key: string]: unknown;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface FetchJsonResult {
    ok: boolean;
    status?: number;
    // Typed as `any` intentionally: each endpoint returns a different shape;
    // callers are responsible for narrowing. Using `unknown` would require casts
    // at every call site which adds noise without safety on a global-scope script.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
    error?: string;
  }

  interface ChartHandle {
    destroy(): void;
    resize?(): void;
    toBase64Image?(type?: string, quality?: number): string;
  }

  // ─── Session constants (04-state.js) ─────────────────────────────────────

  // ─── Global state + chart registry ───────────────────────────────────────

  // ─── Tab / UI navigation ──────────────────────────────────────────────────

  // ─── Formatting helpers ───────────────────────────────────────────────────

  // ─── Portfolio / positions ────────────────────────────────────────────────

  // ─── Risk / what-if ───────────────────────────────────────────────────────

  // ─── Alerts / marks ──────────────────────────────────────────────────────

  // ─── Journal ─────────────────────────────────────────────────────────────

  // ─── Simulation ──────────────────────────────────────────────────────────

  // ─── Snapshots ───────────────────────────────────────────────────────────

  // ─── Session ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  // ─── Chart utils (03-chart-utils.ts) ─────────────────────────────────────

  // ─── Chart.js global ─────────────────────────────────────────────────────
  const Chart: any;
}
