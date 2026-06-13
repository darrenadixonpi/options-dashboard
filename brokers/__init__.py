"""Broker adapter registry (Phase 7.1).

A single place that knows every supported broker. Core code (``app.py``) asks the
registry for an adapter by key and works against the uniform :class:`BrokerAdapter`
interface — so adding a broker is "write an adapter + register it here", with no
edits to routes, simulation, greeks, or the journal.

    from brokers import get_adapter, list_adapters

    legs = get_adapter("fidelity").get_positions(csv_text)   # canonical legs
    legs = get_adapter("schwab").get_positions()             # live OAuth sync
"""

from __future__ import annotations

from typing import Any

from .base import BrokerAdapter, BrokerError, BrokerNotFound, normalize_leg
from .fidelity import FidelityAdapter
from .ibkr import IBKRAdapter
from .schwab import SchwabAdapter

# Order here is the order surfaced in the UI / GET /api/brokers.
_ADAPTER_CLASSES: list[type[BrokerAdapter]] = [
    FidelityAdapter,
    SchwabAdapter,
    IBKRAdapter,
]

# Instantiate once (adapters are stateless aside from lazy client lookups).
REGISTRY: dict[str, BrokerAdapter] = {cls.key: cls() for cls in _ADAPTER_CLASSES}


def get_adapter(key: str) -> BrokerAdapter:
    """Return the adapter for ``key`` (case-insensitive). Raises BrokerNotFound."""
    adapter = REGISTRY.get((key or "").strip().lower())
    if adapter is None:
        raise BrokerNotFound(
            f"Unknown broker '{key}'. Known: {', '.join(sorted(REGISTRY))}"
        )
    return adapter


def list_adapters() -> list[dict[str, Any]]:
    """Return capability descriptors for every registered broker (registry order)."""
    return [REGISTRY[cls.key].capabilities() for cls in _ADAPTER_CLASSES]


__all__ = [
    "BrokerAdapter",
    "BrokerError",
    "BrokerNotFound",
    "normalize_leg",
    "get_adapter",
    "list_adapters",
    "REGISTRY",
    "FidelityAdapter",
    "SchwabAdapter",
    "IBKRAdapter",
]
