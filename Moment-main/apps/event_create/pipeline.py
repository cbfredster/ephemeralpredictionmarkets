"""
Event-create LLM pipeline for event creation.

Focus:
  - preopen_volatility: fully implemented from scanner JSON
  - intraday_volatility: fully implemented from scanner JSON
  - f1_safety_car_laps: fully implemented from vision starter JSON
  - f1_race: skeleton output
  - preopen output also includes:
      * ai_summary (2-3 lines)
      * article_url (if provided in input)

Usage:
  1) stdin:
     python event_create/pipeline.py < input.json

  2) file:
     python event_create/pipeline.py path/to/input.json

  3) default file (no args):
     python event_create/pipeline.py
     -> reads event_create/preopen_input.json
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib import error, request

DEFAULT_INPUT_FILE = "preopen_input.json"


def _die(message: str) -> "None":
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(1)


def _load_input() -> dict[str, Any]:
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            return json.load(f)

    # If JSON is piped into stdin, use it first.
    if not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        if raw:
            try:
                return json.loads(raw)
            except json.JSONDecodeError as exc:
                _die(f"Invalid JSON input: {exc}")

    # Otherwise fall back to default local file in event_create/.
    default_path = Path(__file__).resolve().parent / DEFAULT_INPUT_FILE
    if default_path.exists():
        with default_path.open("r", encoding="utf-8") as f:
            return json.load(f)

    _die(
        "No JSON input provided. Pass a file path, pipe JSON via stdin, "
        f"or create {default_path}."
    )


def _require(payload: dict[str, Any], keys: list[str]) -> None:
    missing = [k for k in keys if k not in payload]
    if missing:
        _die(f"Missing required fields: {', '.join(missing)}")


def _get_event_id(payload: dict[str, Any]) -> int | str:
    current = payload.get("event_id")
    if isinstance(current, int) and not isinstance(current, bool):
        return current
    if isinstance(current, str) and current.strip():
        return current.strip()
    current = payload.get("bet_id")
    if isinstance(current, int) and not isinstance(current, bool):
        return current
    if isinstance(current, str) and current.strip():
        return current.strip()
    return str(uuid.uuid4())


def _load_env_file(path: Path) -> None:
    """
    Minimal .env loader without external dependency.
    Existing process env vars take precedence and are never overwritten.
    """
    if not path.exists() or not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _bootstrap_env() -> None:
    """
    Load env values for this pipeline.
    Priority:
      1) process env
      2) repo root .env
      3) event_create/.env
      4) trading/.env (fallback)
    """
    base_dir = Path(__file__).resolve().parent
    _load_env_file(base_dir.parent.parent / ".env")
    _load_env_file(base_dir / ".env")
    _load_env_file(base_dir.parent / "trading" / ".env")


class GeminiClient:
    """
    Optional Gemini adapter.
    If GEMINI_API_KEY is missing or the call fails, pipeline falls back to deterministic output.
    """

    def __init__(self) -> None:
        self.api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def generate_json(
        self,
        schema_name: str,
        source_payload: dict[str, Any],
        task: str = "Return ONLY valid JSON for event creation.",
        extra_rules: list[str] | None = None,
    ) -> dict[str, Any] | None:
        if not self.enabled:
            return None

        endpoint = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent?key={self.api_key}"
        )

        rules = [
            "Do not add markdown.",
            "Do not include explanation text.",
            "Preserve numeric fields as numbers.",
            "Keep event_id unchanged if provided.",
        ]
        if extra_rules:
            rules.extend(extra_rules)

        prompt = {
            "task": task,
            "schema_name": schema_name,
            "source_payload": source_payload,
            "rules": rules,
        }

        body = {
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.2,
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": json.dumps(prompt)}],
                }
            ],
        }

        req = request.Request(
            endpoint,
            method="POST",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )

        try:
            with request.urlopen(req, timeout=12) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
        except (error.URLError, error.HTTPError, TimeoutError):
            return None

        try:
            text = raw["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
            return None
        except (KeyError, IndexError, json.JSONDecodeError, TypeError):
            return None


def _pick_article_url(payload: dict[str, Any]) -> str | None:
    for key in ("article_url", "url", "link", "source_url"):
        value = payload.get(key)
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned.startswith("http://") or cleaned.startswith("https://"):
                return cleaned
    return None


def _volatility_band(move_abs: float) -> str:
    if move_abs >= 8:
        return "extreme"
    if move_abs >= 4:
        return "very high"
    if move_abs >= 2:
        return "high"
    return "elevated"


def _volume_band(dollar_volume: float) -> str:
    if dollar_volume >= 2_000_000_000:
        return "massive"
    if dollar_volume >= 500_000_000:
        return "heavy"
    if dollar_volume >= 100_000_000:
        return "strong"
    return "building"


def _article_for(word: str) -> str:
    return "an" if word[:1].lower() in {"a", "e", "i", "o", "u"} else "a"


def _fallback_preopen_summary(
    ticker: str,
    volatility: float,
    price: float,
    close_price: float,
    dollar_volume: float,
    context: str,
) -> str:
    direction = "up" if volatility >= 0 else "down"
    move_abs = abs(volatility)
    vol_tag = _volatility_band(move_abs)
    flow_tag = _volume_band(dollar_volume)
    action_word = "squeeze risk" if volatility >= 0 else "flush risk"
    article = _article_for(vol_tag)
    return (
        f"{ticker} is in {article} {vol_tag} preopen move: {move_abs:.2f}% {direction} "
        f"(${close_price:.2f} -> ${price:.2f}).\n"
        f"Flow is {flow_tag} with ${dollar_volume:,.0f} traded before the open, so "
        f"opening auction {action_word} is in play.\n"
        f"Catalyst in focus: {context}"
    )


def _compute_preopen_target_move_pct(volatility: float) -> float:
    mode = os.getenv("PREOPEN_TARGET_MODE", "dynamic").strip().lower()
    if mode == "fixed":
        fixed = abs(float(os.getenv("PREOPEN_TARGET_MOVE_PCT", "2.0")))
        return round(max(0.05, fixed), 2)

    scale = max(0.01, float(os.getenv("PREOPEN_TARGET_SCALE", "0.25")))
    min_pct = max(0.05, abs(float(os.getenv("PREOPEN_TARGET_MIN_PCT", "0.5"))))
    max_pct = max(0.1, abs(float(os.getenv("PREOPEN_TARGET_MAX_PCT", "4.0"))))
    lo = min(min_pct, max_pct)
    hi = max(min_pct, max_pct)
    raw = abs(volatility) * scale
    return round(min(hi, max(lo, raw)), 2)


def _build_preopen_event(payload: dict[str, Any], llm: GeminiClient) -> dict[str, Any]:
    _require(
        payload,
        [
            "ticker",
            "volatility",
            "price",
            "price_at",
            "close_price",
            "dollar_volume",
            "context",
            "published_at",
        ],
    )

    ticker = str(payload["ticker"]).upper()
    price = float(payload["price"])
    volatility = float(payload["volatility"])
    close_price = float(payload["close_price"])
    dollar_volume = float(payload["dollar_volume"])
    context = str(payload["context"])
    article_url = _pick_article_url(payload)
    target_move_pct = _compute_preopen_target_move_pct(volatility)
    target_direction = "UP" if volatility >= 0 else "DOWN"
    direction_sign = 1 if target_direction == "UP" else -1
    target_multiplier = 1 + (target_move_pct / 100.0) * direction_sign
    target_price = round(price * target_multiplier, 4)
    base = {
        "event_id": _get_event_id(payload),
        "event_type": "preopen_volatility",
        "question": (
            f"Will {ticker} move {target_direction} another {target_move_pct:.2f}% "
            f"from ${price:.2f} by the open settlement window?"
        ),
        "ticker": ticker,
        "volatility": volatility,
        "price": price,
        "price_at": str(payload["price_at"]),
        "close_price": close_price,
        "dollar_volume": dollar_volume,
        "target_direction": target_direction,
        "target_move_pct": target_move_pct,
        "target_price": target_price,
        "context": context,
        "published_at": str(payload["published_at"]),
        "article_url": article_url,
        "ai_summary": _fallback_preopen_summary(
            ticker=ticker,
            volatility=volatility,
            price=price,
            close_price=close_price,
            dollar_volume=dollar_volume,
            context=context,
        ),
    }

    llm_result = llm.generate_json(
        "preopen_volatility_event",
        base,
        task=(
            "Return ONLY valid JSON with keys: question, context, ai_summary. "
            "ai_summary must be exactly 3 short lines that feel engaging for a fast preopen market event."
        ),
        extra_rules=[
            "Keep ai_summary concise, energetic, and factual.",
            "Do not give financial advice, guarantees, or certainty language.",
            "Line 1 must include ticker, move %, and close->current price.",
            "Line 2 must include dollar_volume and what it implies for open volatility.",
            "Line 3 must connect the provided context headline to why this setup matters now.",
            "Do not invent article URLs.",
        ],
    )
    if isinstance(llm_result, dict):
        # Keep strict shape and trusted id/type, allow Gemini to improve question/context text.
        for key in ("question", "context", "ai_summary"):
            if key in llm_result and isinstance(llm_result[key], str) and llm_result[key].strip():
                base[key] = llm_result[key].strip()
    return base


def _fallback_intraday_summary(
    ticker: str,
    volatility: float,
    starting_price: float,
    target_move_pct: float,
    duration_seconds: int,
    context: str,
) -> str:
    direction = "up" if volatility >= 0 else "down"
    move_abs = abs(volatility)
    duration_minutes = max(1, round(duration_seconds / 60))
    return (
        f"{ticker} just printed a {move_abs:.2f}% {direction} volatility burst from ${starting_price:.2f}.\n"
        f"This event gives {duration_minutes} minute(s) for a further {target_move_pct:.2f}% move in the same direction.\n"
        f"Likely catalyst: {context}"
    )


def _build_intraday_event(payload: dict[str, Any], llm: GeminiClient) -> dict[str, Any]:
    _require(payload, ["ticker", "volatility", "price", "price_at"])
    ticker = str(payload["ticker"]).upper()
    volatility = float(payload["volatility"])
    starting_price = float(payload["price"])
    target_move_pct = abs(float(payload.get("target_move_pct", 5.0)))
    duration_seconds = max(15, int(payload.get("duration_seconds", 180)))
    direction = "UP" if volatility >= 0 else "DOWN"
    context = str(payload.get("context", "No clear catalyst headline available."))
    published_at = str(payload.get("published_at", "Unknown"))
    article_url = _pick_article_url(payload)

    base = {
        "event_id": _get_event_id(payload),
        "event_type": "intraday_volatility",
        "question": (
            f"Will {ticker} move {direction} another {target_move_pct:.2f}% "
            f"from ${starting_price:.2f} in the next {duration_seconds} seconds?"
        ),
        "ticker": ticker,
        "volatility": volatility,
        "price": starting_price,
        "price_at": str(payload["price_at"]),
        "starting_price": starting_price,
        "starting_price_at": str(payload.get("starting_price_at", payload["price_at"])),
        "target_move_pct": target_move_pct,
        "duration_seconds": duration_seconds,
        "context": context,
        "published_at": published_at,
        "article_url": article_url,
        "ai_summary": _fallback_intraday_summary(
            ticker=ticker,
            volatility=volatility,
            starting_price=starting_price,
            target_move_pct=target_move_pct,
            duration_seconds=duration_seconds,
            context=context,
        ),
    }

    llm_result = llm.generate_json(
        "intraday_volatility_event",
        base,
        task=(
            "Return ONLY valid JSON with keys: question, context, ai_summary. "
            "ai_summary must be exactly 3 short lines for a fast intraday volatility event."
        ),
        extra_rules=[
            "Keep ai_summary concise, energetic, and factual.",
            "Do not give financial advice, guarantees, or certainty language.",
            "Line 1 must include ticker, initial volatility %, and starting price.",
            "Line 2 must include duration_seconds and target_move_pct with urgency.",
            "Line 3 must connect the provided context headline to why this setup matters now.",
            "Do not invent article URLs.",
        ],
    )
    if isinstance(llm_result, dict):
        for key in ("question", "context", "ai_summary"):
            if key in llm_result and isinstance(llm_result[key], str) and llm_result[key].strip():
                base[key] = llm_result[key].strip()
    return base


def _build_f1_skeleton(payload: dict[str, Any], llm: GeminiClient) -> dict[str, Any]:
    driver_behind = str(payload.get("driver_behind", "Norris"))
    driver_ahead = str(payload.get("driver_ahead", "Verstappen"))
    position_ahead = int(payload.get("position_ahead", 1))

    base = {
        "event_id": _get_event_id(payload),
        "event_type": "f1_race",
        "question": f"Will {driver_behind} overtake {driver_ahead}?",
        "driver_behind": driver_behind,
        "driver_ahead": driver_ahead,
        "position_ahead": position_ahead,
    }

    llm_result = llm.generate_json("f1_event", base)
    if isinstance(llm_result, dict):
        if isinstance(llm_result.get("question"), str) and llm_result["question"].strip():
            base["question"] = llm_result["question"].strip()
    return base


def _fallback_f1_safety_car_summary(
    line_laps: float,
    duration_seconds: int,
    lap_start: int | None,
    confidence: float,
    context: str,
) -> str:
    lap_text = f"Lap {lap_start}" if isinstance(lap_start, int) and lap_start > 0 else "Lap unknown"
    confidence_pct = max(0.0, min(100.0, confidence * 100.0))
    return (
        f"Safety Car trigger detected at {lap_text} with {confidence_pct:.0f}% model confidence.\n"
        f"This market asks OVER/UNDER {line_laps:.1f} laps and is open for {duration_seconds}s.\n"
        f"Signal context: {context}"
    )


def _build_f1_safety_car_event(payload: dict[str, Any], llm: GeminiClient) -> dict[str, Any]:
    trigger_type = str(payload.get("trigger_type", "SAFETY_CAR_START")).strip().upper()
    session_id = str(payload.get("session_id", "unknown-session")).strip()
    line_laps = float(payload.get("market_line_laps", 3.5))
    if line_laps <= 0:
        line_laps = 3.5

    duration_seconds = max(30, int(payload.get("duration_seconds", 60)))
    raw_lap = payload.get("lap_start", payload.get("lap"))
    lap_start = int(raw_lap) if isinstance(raw_lap, int) and raw_lap > 0 else None

    confidence = float(payload.get("source_confidence", payload.get("confidence", 0.0)))
    confidence = max(0.0, min(1.0, confidence))
    context = str(payload.get("context", "Safety Car banner detected from the live vision feed."))
    published_at = str(payload.get("published_at", "Unknown"))
    source_event_id = str(payload.get("source_event_id", payload.get("event_source_id", ""))).strip() or None

    base = {
        "event_id": _get_event_id(payload),
        "event_type": "f1_safety_car_laps",
        "question": f"Will the Safety Car be out for OVER {line_laps:.1f} laps?",
        "session_id": session_id,
        "trigger_type": trigger_type,
        "lap_start": lap_start,
        "market_line_laps": line_laps,
        "duration_seconds": duration_seconds,
        "source_confidence": confidence,
        "source_event_id": source_event_id,
        "published_at": published_at,
        "context": context,
        "ai_summary": _fallback_f1_safety_car_summary(
            line_laps=line_laps,
            duration_seconds=duration_seconds,
            lap_start=lap_start,
            confidence=confidence,
            context=context,
        ),
    }

    llm_result = llm.generate_json(
        "f1_safety_car_event",
        base,
        task=(
            "Return ONLY valid JSON with keys: question, context, ai_summary. "
            "ai_summary must be exactly 3 short lines for a fast F1 safety-car market."
        ),
        extra_rules=[
            "Keep ai_summary concise, energetic, and factual.",
            "Do not give guarantees or certainty language.",
            "Line 1 must include safety car trigger plus lap if available.",
            "Line 2 must include market_line_laps and duration_seconds.",
            "Line 3 must explain why this is a fast decision moment.",
        ],
    )
    if isinstance(llm_result, dict):
        for key in ("question", "context", "ai_summary"):
            if key in llm_result and isinstance(llm_result[key], str) and llm_result[key].strip():
                base[key] = llm_result[key].strip()
    return base


def build_event_payload(source_payload: dict[str, Any]) -> dict[str, Any]:
    """
    Route by event type.
    Supported:
      - preopen_volatility (implemented)
      - intraday_volatility (implemented)
      - f1_race (skeleton)
      - f1_safety_car_laps (implemented)
    """
    llm = GeminiClient()
    raw_type = source_payload.get("event_type", source_payload.get("bet_type", ""))
    event_type = str(raw_type).strip().lower()

    if event_type == "preopen_volatility":
        return _build_preopen_event(source_payload, llm)
    if event_type == "intraday_volatility":
        return _build_intraday_event(source_payload, llm)
    if event_type in {"f1_safety_car_laps", "f1_safety_car", "vision_f1_safety_car"}:
        return _build_f1_safety_car_event(source_payload, llm)
    if event_type in {"f1_race", "f1"}:
        return _build_f1_skeleton(source_payload, llm)

    _die(
        "Unsupported or missing event_type/bet_type. "
        "Expected preopen_volatility, intraday_volatility, f1_safety_car_laps, or f1_race."
    )


def main() -> None:
    _bootstrap_env()
    source_payload = _load_input()
    output = build_event_payload(source_payload)
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
