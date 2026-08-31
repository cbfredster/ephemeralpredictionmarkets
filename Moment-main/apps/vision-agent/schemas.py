from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class StarterSignal(BaseModel):
    event_id: str
    sport: str = "F1"
    trigger_type: str
    session_id: str
    timestamp_ms: int
    lap: Optional[int] = None
    driver: Optional[str] = None
    rival_driver: Optional[str] = None
    confidence: float = Field(ge=0.0, le=1.0)
    cooldown_key: str
    market_duration_ms: int = Field(ge=30_000, le=900_000)
    context: dict[str, Any] = Field(default_factory=dict)


class ResolutionSignal(BaseModel):
    event_id: str
    market_id: str
    outcome: str
    confidence: float = Field(ge=0.0, le=1.0)
    resolved_at_ms: int
    reason: str = "vision_signal"
    context: dict[str, Any] = Field(default_factory=dict)
