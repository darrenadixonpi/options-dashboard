"""Pydantic models for core API JSON responses (Phase 1 — contract validation)."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class ErrorResponse(BaseModel):
    error: str


class PnlStats(ApiModel):
    mean: float
    median: float
    p5: float
    p25: float
    p75: float
    p95: float
    min: float
    max: float
    prob_profit: float


class Histogram(ApiModel):
    counts: list[int]
    edges: list[float]


class TickerSimStats(PnlStats):
    model: str = "gbm"
    reason: str = ""
    price: Optional[float] = None
    iv: Optional[float] = None


class ThetaGroup(ApiModel):
    label: str
    color: str
    daily: list[float]
    expiry: str


class ThetaMilestone(ApiModel):
    date: str
    index: int
    value: float


class ThetaData(ApiModel):
    dates: list[str]
    groups: list[ThetaGroup]
    totalDaily: list[float]
    cumulative: list[float]
    cumulativeNet: list[float]
    milestones: list[ThetaMilestone] = Field(default_factory=list)
    todayTheta: float
    todayEarned: float
    todayCost: float
    totalCumulative: float
    totalCumulativeNet: float
    nextExpiry: Optional[str] = None
    postNextTheta: float = 0


class CorrelationInfo(ApiModel):
    tickers: list[str]
    matrix: list[list[float]]


class TickerPathData(ApiModel):
    dates: list[str]
    p5: list[float]
    p25: list[float]
    p50: list[float]
    p75: list[float]
    p95: list[float]
    mean: list[float]
    strikes: list[Any] = Field(default_factory=list)
    breakevens: list[Any] = Field(default_factory=list)
    model: str = "gbm"
    shares: float = 0
    adjCost: Optional[float] = None


class SimulateResponse(ApiModel):
    n_paths: int
    portfolio: PnlStats
    by_ticker: dict[str, TickerSimStats]
    by_strategy: dict[str, PnlStats]
    histogram: Histogram
    portfolio_pnl: list[float]
    ticker_histograms: dict[str, Histogram]
    ticker_paths: dict[str, TickerPathData]
    theta: Optional[ThetaData] = None
    correlation: Optional[CorrelationInfo] = None


class GreeksBundle(ApiModel):
    delta: float
    gamma: float
    theta: float
    vega: float


class BetaWeighted(ApiModel):
    delta: float
    spyPrice: float
    equivalent: str


class GreeksResponse(ApiModel):
    positions: list[dict[str, Any]]
    byTicker: dict[str, GreeksBundle]
    portfolio: GreeksBundle
    betaWeighted: Optional[BetaWeighted] = None
    risk: dict[str, Any]


def validate_response(model_cls: type[BaseModel], data: Any) -> dict[str, Any]:
    """Validate API payload and return JSON-serializable dict."""
    return model_cls.model_validate(data).model_dump(mode="json")


# ─── Schwab API schemas (Phase 6) ─────────────────────────────────────────────


class SchwabStatusResponse(BaseModel):
    configured: bool
    authenticated: bool
    needs_reauth: bool
    token_age_hours: Optional[float] = None
    callback_url: Optional[str] = None


class SchwabLegResponse(ApiModel):
    ticker: str
    posType: str
    optType: Optional[str] = None
    strike: Optional[float] = None
    expiry: Optional[str] = None
    contracts: int = 0
    shares: int = 0
    avgCost: float = 0.0
    source: str = "schwab_api"


class SchwabSyncResponse(BaseModel):
    positions: list[SchwabLegResponse]
    position_count: int
    synced_at: str
