from dataclasses import dataclass


@dataclass(frozen=True)
class YellowFlagConfig:
    roi_top_ratio: float = 0.0
    roi_bottom_ratio: float = 0.25
    confirm_hits: int = 5
    confirm_window: int = 8
    cooldown_seconds: int = 45
    confidence_threshold: float = 0.8
    market_duration_ms: int = 60_000


@dataclass(frozen=True)
class SafetyCarConfig:
    confirm_hits: int = 4
    confirm_window: int = 6
    confidence_threshold: float = 0.8


@dataclass(frozen=True)
class SafetyCarLapsConfig:
    roi_top_ratio: float = 0.0
    roi_bottom_ratio: float = 0.25
    roi_right_ratio: float = 1.0
    # Fire immediately on first detection for hackathon responsiveness.
    start_confirm_hits: int = 1
    start_confirm_window: int = 1
    ending_confirm_hits: int = 1
    ending_confirm_window: int = 1
    cooldown_seconds: int = 60
    confidence_threshold: float = 0.8
    market_duration_ms: int = 600_000
    lap_capture_wait_s: float = 0.0
