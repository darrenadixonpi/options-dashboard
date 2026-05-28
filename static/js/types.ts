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
    totalPremium?: number;
    [key: string]: unknown;
  }

  interface FetchJsonResult {
    ok: boolean;
    status?: number;
    data: Record<string, unknown> & Partial<SimulateResult>;
    error?: string;
  }

  interface ChartHandle {
    destroy(): void;
    resize?(): void;
    toBase64Image?(type?: string): string;
  }

  const state: AppState;
  const chartInstances: Record<string, ChartHandle>;

  function switchToTab(tab: string, opts?: { scrollTop?: boolean }): void;
  function destroyChart(id: string): void;
  function dateKey(d: Date): string;
  function renderPortfolio(portfolio: Record<string, unknown>, hasMarket: boolean): void;
  function refreshDeskAlerts(): void;
  function saveSession(): void;
  function jumpToSimTicker(tkr: string): void;
  function setupSimNavScrollSpy(): void;

  const Chart: new (
    ctx: CanvasRenderingContext2D | HTMLCanvasElement,
    config: Record<string, unknown>
  ) => ChartHandle;
}
