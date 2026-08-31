"""
Scanner + event pipeline runner.

Modes:
  - preopen: multi-ticker events during preopen window, closes at open
  - intraday: multi-ticker events, one active event per ticker, short TTL
  - vision: ingests vision-agent starter/resolution JSON and emits the same event lifecycle
  - auto: picks preopen if currently in preopen window, otherwise intraday

Usage:
  python trading/scanner_events.py --mode preopen --backtest-time 2025-04-03T13:27:00Z
  python trading/scanner_events.py --mode intraday --backtest-time 2025-04-09T17:20:00Z
  python trading/scanner_events.py --mode vision --vision-input path/to/vision_signals.ndjson
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

_EMIT_API_BASE_URL: str | None = None
_EMIT_API_TIMEOUT_SECONDS = 3


@dataclass
class ActiveEvent:
    payload: dict[str, Any]
    created_dt: datetime
    expires_dt: datetime
    settle_dt: datetime | None = None
    locked_emitted: bool = False
    direction: int = 0
    target_price: float | None = None
    target_hit: bool = False
    target_hit_at: str | None = None
    max_price_seen: float | None = None
    min_price_seen: float | None = None
    max_favorable_move_pct: float = 0.0

    @property
    def created_at(self) -> str:
        return _iso(self.created_dt)

    @property
    def expires_at(self) -> str:
        return _iso(self.expires_dt)

    @property
    def settle_at(self) -> str | None:
        if self.settle_dt is None:
            return None
        return _iso(self.settle_dt)


@dataclass
class Config:
    mode: str
    window_minutes: int
    preopen_settle_minutes: int
    poll_seconds: int
    step_minutes: int
    intraday_step_seconds: int
    replay_delay: int
    max_ticks: int
    backtest_time: datetime | None
    backtest_time_str: str
    intraday_duration_seconds: int
    intraday_ticker_cooldown_seconds: int
    intraday_target_mode: str
    intraday_target_move_pct: float
    intraday_target_min_pct: float
    intraday_target_max_pct: float
    intraday_target_scale: float
    event_id_start: int
    vision_input: str
    api_base_url: str


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso_utc(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Invalid ISO datetime '{value}'. Use 2025-04-03T13:27:00Z.") from exc
    return dt.astimezone(timezone.utc)


def _load_env_file(path: Path) -> None:
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
    apps_root = Path(__file__).resolve().parent.parent
    repo_root = apps_root.parent
    _load_env_file(repo_root / ".env")
    # Backward-compatible fallbacks while migrating.
    _load_env_file(apps_root / "trading" / ".env")
    _load_env_file(apps_root / "event_create" / ".env")


def _import_modules() -> tuple[Any, Any]:
    root = Path(__file__).resolve().parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    scanner = importlib.import_module("trading.scanner")
    pipeline = importlib.import_module("event_create.pipeline")
    return scanner, pipeline


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run scanner + event pipeline lifecycle.")
    parser.add_argument("--mode", type=str, default=os.getenv("SCANNER_EVENTS_MODE", "preopen"))
    parser.add_argument("--backtest-time", type=str, default=os.getenv("BACKTEST_TIME", ""))
    parser.add_argument("--window-minutes", type=int, default=int(os.getenv("PREOPEN_WINDOW", "10")))
    parser.add_argument(
        "--preopen-settle-minutes",
        type=int,
        default=int(os.getenv("PREOPEN_SETTLE_MINUTES", "1")),
    )
    parser.add_argument("--poll-seconds", type=int, default=int(os.getenv("POLL_INTERVAL", "15")))
    parser.add_argument("--step-minutes", type=int, default=int(os.getenv("BACKTEST_STEP", "1")))
    parser.add_argument(
        "--intraday-step-seconds",
        type=int,
        default=int(os.getenv("INTRADAY_STEP_SECONDS", "30")),
    )
    parser.add_argument("--replay-delay", type=int, default=int(os.getenv("REPLAY_DELAY", "0")))
    parser.add_argument("--max-ticks", type=int, default=int(os.getenv("REPLAY_TICKS", "0")))
    parser.add_argument(
        "--intraday-duration-seconds",
        type=int,
        default=int(os.getenv("INTRADAY_EVENT_DURATION_SECONDS", "180")),
    )
    parser.add_argument(
        "--intraday-ticker-cooldown-seconds",
        type=int,
        default=int(os.getenv("INTRADAY_TICKER_COOLDOWN_SECONDS", "0")),
        help="Per-ticker cooldown after close; 0 means use event duration.",
    )
    parser.add_argument(
        "--intraday-target-mode",
        type=str,
        default=os.getenv("INTRADAY_TARGET_MODE", "dynamic"),
        help="dynamic or fixed",
    )
    parser.add_argument(
        "--intraday-target-move-pct",
        type=float,
        default=float(os.getenv("INTRADAY_TARGET_MOVE_PCT", "5")),
    )
    parser.add_argument(
        "--intraday-target-min-pct",
        type=float,
        default=float(os.getenv("INTRADAY_TARGET_MIN_PCT", "0.5")),
    )
    parser.add_argument(
        "--intraday-target-max-pct",
        type=float,
        default=float(os.getenv("INTRADAY_TARGET_MAX_PCT", "3.0")),
    )
    parser.add_argument(
        "--intraday-target-scale",
        type=float,
        default=float(os.getenv("INTRADAY_TARGET_SCALE", "0.35")),
    )
    parser.add_argument("--event-id-start", type=int, default=int(os.getenv("EVENT_ID_START", "1")))
    parser.add_argument(
        "--vision-input",
        type=str,
        default=os.getenv("VISION_INPUT", ""),
        help="Path to JSON/NDJSON file with vision starter/resolution signals. "
        "Unset => read JSON lines from stdin.",
    )
    parser.add_argument(
        "--api-base-url",
        type=str,
        default=os.getenv("MOMENT_API_BASE_URL", "http://127.0.0.1:4000"),
        help="Optional Moment API base URL (for example http://127.0.0.1:4000). "
        "When set, emitted lifecycle events are POSTed to /scanner/events.",
    )
    return parser.parse_args()


def _build_config(scanner: Any, args: argparse.Namespace) -> Config:
    mode = str(args.mode).strip().lower() or "preopen"
    if mode not in {"preopen", "intraday", "auto", "vision"}:
        raise ValueError("SCANNER_EVENTS_MODE must be preopen, intraday, auto, or vision.")
    intraday_target_mode = str(args.intraday_target_mode).strip().lower() or "dynamic"
    if intraday_target_mode not in {"dynamic", "fixed"}:
        raise ValueError("INTRADAY_TARGET_MODE must be dynamic or fixed.")

    if mode == "vision":
        backtest_time = None
        backtest_time_str = ""
    else:
        raw_backtest = str(args.backtest_time or "").strip()
        if raw_backtest:
            backtest_time = _parse_iso_utc(raw_backtest)
            backtest_time_str = raw_backtest
        else:
            backtest_time = scanner.parse_backtest_time()
            backtest_time_str = scanner.BACKTEST_TIME_STR if backtest_time else ""

    intraday_duration_seconds = max(15, int(args.intraday_duration_seconds))
    raw_cooldown_seconds = max(0, int(args.intraday_ticker_cooldown_seconds))
    intraday_ticker_cooldown_seconds = (
        raw_cooldown_seconds if raw_cooldown_seconds > 0 else intraday_duration_seconds
    )

    return Config(
        mode=mode,
        window_minutes=max(1, int(args.window_minutes)),
        preopen_settle_minutes=max(1, int(args.preopen_settle_minutes)),
        poll_seconds=max(1, int(args.poll_seconds)),
        step_minutes=max(1, int(args.step_minutes)),
        intraday_step_seconds=max(1, int(args.intraday_step_seconds)),
        replay_delay=max(0, int(args.replay_delay)),
        max_ticks=max(0, int(args.max_ticks)),
        backtest_time=backtest_time,
        backtest_time_str=backtest_time_str,
        intraday_duration_seconds=intraday_duration_seconds,
        intraday_ticker_cooldown_seconds=intraday_ticker_cooldown_seconds,
        intraday_target_mode=intraday_target_mode,
        intraday_target_move_pct=abs(float(args.intraday_target_move_pct)),
        intraday_target_min_pct=max(0.05, abs(float(args.intraday_target_min_pct))),
        intraday_target_max_pct=max(0.1, abs(float(args.intraday_target_max_pct))),
        intraday_target_scale=max(0.01, float(args.intraday_target_scale)),
        event_id_start=max(1, int(args.event_id_start)),
        vision_input=str(args.vision_input or "").strip(),
        api_base_url=str(args.api_base_url or "").strip(),
    )


def _normalize_api_base_url(value: str) -> str:
    return value.rstrip("/")


def _set_emit_api_base_url(value: str) -> None:
    global _EMIT_API_BASE_URL
    normalized = _normalize_api_base_url(value.strip()) if value else ""
    _EMIT_API_BASE_URL = normalized if normalized else None


def _post_event_to_api(payload: dict[str, Any]) -> None:
    if _EMIT_API_BASE_URL is None:
        return
    url = f"{_EMIT_API_BASE_URL}/scanner/events"
    try:
        response = requests.post(url, json=payload, timeout=_EMIT_API_TIMEOUT_SECONDS)
    except Exception as exc:
        print(f"[scanner_events] API post failed url={url}: {exc}", file=sys.stderr)
        return

    if response.status_code >= 400:
        body = response.text.strip()
        print(
            f"[scanner_events] API post rejected status={response.status_code} url={url} body={body}",
            file=sys.stderr,
        )


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2), flush=True)
    _post_event_to_api(payload)


def _market_open_utc(as_of: datetime) -> datetime:
    return as_of.replace(hour=13, minute=30, second=0, microsecond=0)


def _market_close_utc(as_of: datetime) -> datetime:
    return as_of.replace(hour=20, minute=0, second=0, microsecond=0)


def _in_regular_market_hours(as_of: datetime) -> bool:
    open_utc = _market_open_utc(as_of)
    close_utc = _market_close_utc(as_of)
    return open_utc <= as_of <= close_utc


def _in_preopen_window(as_of: datetime, window_minutes: int) -> bool:
    open_utc = _market_open_utc(as_of)
    window_start = open_utc - timedelta(minutes=window_minutes)
    return window_start <= as_of < open_utc


def _resolve_mode(config_mode: str, as_of: datetime, window_minutes: int) -> str:
    if config_mode == "vision":
        return "vision"
    if config_mode == "auto":
        return "preopen" if _in_preopen_window(as_of, window_minutes) else "intraday"
    return config_mode


def _next_event_id(counter: list[int]) -> int:
    value = counter[0]
    counter[0] += 1
    return value


def _compute_intraday_target_move_pct(volatility: float, cfg: Config) -> float:
    if cfg.intraday_target_mode == "fixed":
        return round(max(0.05, cfg.intraday_target_move_pct), 2)

    # Dynamic target sizing: scale with detected spike magnitude and clamp to sane bounds.
    raw = abs(volatility) * cfg.intraday_target_scale
    lo = min(cfg.intraday_target_min_pct, cfg.intraday_target_max_pct)
    hi = max(cfg.intraday_target_min_pct, cfg.intraday_target_max_pct)
    return round(min(hi, max(lo, raw)), 2)


def _build_preopen_source_payload(
    scanner: Any,
    candidate: dict[str, Any],
    as_of: datetime,
    event_id: int,
) -> dict[str, Any]:
    ticker = str(candidate["ticker"]).upper()
    context, published_at, article_url = scanner.get_news(ticker, as_of, "gap")
    return {
        "event_id": event_id,
        "event_type": "preopen_volatility",
        "ticker": ticker,
        "volatility": float(candidate["volatility"]),
        "price": float(candidate["preopen_price"]),
        "price_at": str(candidate["price_at"]),
        "close_price": float(candidate["close_price"]),
        "dollar_volume": float(candidate["dollar_volume"]),
        "context": context,
        "published_at": published_at,
        "article_url": article_url,
    }


def _fetch_preopen_metrics(scanner: Any, tickers: list[str], as_of: datetime) -> dict[str, dict[str, Any]]:
    if not tickers:
        return {}

    refs = scanner.get_daily_reference_prices(as_of)
    window_start = scanner.overnight_window_start_utc(as_of)
    bars_by_ticker: dict[str, list[dict[str, Any]]] = {}

    def fetch_ticker_bars(ticker: str) -> tuple[str, list[dict[str, Any]]]:
        try:
            resp = requests.get(
                f"{scanner.ALPACA_BASE}/v2/stocks/{ticker}/bars",
                headers=scanner.HEADERS,
                params={
                    "timeframe": "1Min",
                    "start": window_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "end": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "limit": 1500,
                    "feed": "sip",
                    "sort": "asc",
                },
                timeout=15,
            )
            resp.raise_for_status()
            return ticker, resp.json().get("bars", [])
        except Exception:
            return ticker, []

    from concurrent.futures import ThreadPoolExecutor, as_completed

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(fetch_ticker_bars, ticker): ticker for ticker in tickers}
        for future in as_completed(futures):
            ticker, bars = future.result()
            bars_by_ticker[ticker] = bars

    out: dict[str, dict[str, Any]] = {}
    for ticker in tickers:
        ref = refs.get(ticker)
        if not ref:
            continue
        prev_close, maybe_open = ref
        if prev_close <= 0:
            continue

        bars = bars_by_ticker.get(ticker, [])
        if bars:
            latest = bars[-1]
            latest_price = float(latest.get("c", 0))
            latest_time = str(latest.get("t", _iso(as_of)))
            dollar_volume = float(sum(float(bar.get("c", 0)) * float(bar.get("v", 0)) for bar in bars))
        else:
            snapshot = scanner.get_price_snapshot(ticker, as_of)
            if not snapshot:
                continue
            latest_price, latest_time = snapshot
            dollar_volume = 0.0

        if latest_price <= 0:
            continue

        volatility = round((latest_price - prev_close) / prev_close * 100, 4)
        out[ticker] = {
            "price": round(float(latest_price), 4),
            "price_at": latest_time,
            "volatility": volatility,
            "close_price": round(float(prev_close), 4),
            "dollar_volume": round(dollar_volume, 2),
            "official_open_price": round(float(maybe_open), 4) if maybe_open and maybe_open > 0 else None,
        }
    return out


def _create_preopen_events(
    scanner: Any,
    build_event_payload: Any,
    active_events: dict[str, ActiveEvent],
    as_of: datetime,
    cfg: Config,
    id_counter: list[int],
) -> None:
    expires_dt = _market_open_utc(as_of)
    settle_dt = expires_dt + timedelta(minutes=cfg.preopen_settle_minutes)
    try:
        candidates = scanner.get_preopen_candidates(as_of)
    except Exception as exc:
        print(f"[scanner_events] Candidate scan failed at {_iso(as_of)}: {exc}", file=sys.stderr)
        return

    for candidate in candidates:
        ticker = str(candidate["ticker"]).upper()
        if ticker in active_events:
            continue
        event_id = _next_event_id(id_counter)
        try:
            source_payload = _build_preopen_source_payload(scanner, candidate, as_of, event_id)
            created = build_event_payload(source_payload)
            created["event_id"] = event_id
            created["event_type"] = "preopen_volatility"
        except Exception as exc:
            print(f"[scanner_events] Event creation failed for {ticker}: {exc}", file=sys.stderr)
            continue

        state = ActiveEvent(
            payload=created,
            created_dt=as_of,
            expires_dt=expires_dt,
            settle_dt=settle_dt,
        )
        active_events[ticker] = state
        _emit(
            {
                "event": "event_created",
                "event_state": "active",
                "event_at": state.created_at,
                "expires_at": state.expires_at,
                "settle_at": state.settle_at,
                "event_payload": created,
            }
        )


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _preopen_target_hit(
    latest_price: float | None,
    target_price: float | None,
    target_direction: str | None,
    fallback_volatility: float | None = None,
) -> bool | None:
    if latest_price is None or target_price is None:
        return None

    direction = (target_direction or "").strip().upper()
    if direction not in {"UP", "DOWN"}:
        if fallback_volatility is None:
            return None
        direction = "UP" if fallback_volatility >= 0 else "DOWN"

    if direction == "UP":
        return latest_price >= target_price
    return latest_price <= target_price


def _emit_preopen_active_events(scanner: Any, active_events: dict[str, ActiveEvent], as_of: datetime) -> None:
    if not active_events:
        return
    tickers = list(active_events.keys())
    try:
        metrics = _fetch_preopen_metrics(scanner, tickers, as_of)
    except Exception as exc:
        print(f"[scanner_events] Active update failed at {_iso(as_of)}: {exc}", file=sys.stderr)
        return

    for ticker in tickers:
        state = active_events[ticker]
        metric = metrics.get(ticker)
        if not metric:
            continue
        payload = state.payload
        current_price = _to_float(metric.get("price"))
        target_price = _to_float(payload.get("target_price"))
        target_move_pct = _to_float(payload.get("target_move_pct"))
        target_direction = payload.get("target_direction")
        volatility = _to_float(metric.get("volatility"))

        target_hit = _preopen_target_hit(
            latest_price=current_price,
            target_price=target_price,
            target_direction=str(target_direction) if target_direction is not None else None,
            fallback_volatility=volatility,
        )

        _emit(
            {
                "event": "event_active",
                "event_state": "active",
                "event_at": _iso(as_of),
                "expires_at": state.expires_at,
                "settle_at": state.settle_at,
                "event_id": payload.get("event_id"),
                "event_type": payload.get("event_type"),
                "ticker": ticker,
                "question": payload.get("question"),
                "price": metric["price"],
                "price_at": metric["price_at"],
                "volatility": metric["volatility"],
                "close_price": metric["close_price"],
                "dollar_volume": metric["dollar_volume"],
                "target_direction": target_direction,
                "target_move_pct": target_move_pct,
                "target_price": target_price,
                "target_hit": target_hit,
                "context": payload.get("context"),
                "published_at": payload.get("published_at"),
                "article_url": payload.get("article_url"),
                "ai_summary": payload.get("ai_summary"),
            }
        )


def _lock_preopen_events(active_events: dict[str, ActiveEvent], lock_time: datetime) -> None:
    if not active_events:
        return
    for ticker, state in active_events.items():
        if state.locked_emitted:
            continue
        payload = state.payload
        _emit(
            {
                "event": "event_locked",
                "event_state": "locked",
                "event_at": _iso(lock_time),
                "expires_at": state.expires_at,
                "settle_at": state.settle_at,
                "event_id": payload.get("event_id"),
                "event_type": payload.get("event_type"),
                "ticker": ticker,
                "question": payload.get("question"),
            }
        )
        state.locked_emitted = True


def _close_preopen_events(
    scanner: Any,
    active_events: dict[str, ActiveEvent],
    close_time: datetime,
    close_reason: str = "settlement_window_elapsed",
) -> None:
    if not active_events:
        return
    tickers = list(active_events.keys())

    for ticker in tickers:
        state = active_events[ticker]
        payload = state.payload
        target_direction = str(payload.get("target_direction", "")).strip().upper()
        settlement_outcome = "LOWER" if target_direction == "DOWN" else "HIGHER"

        _emit(
            {
                "event": "event_closed",
                "event_state": "closed",
                "event_at": _iso(close_time),
                "close_reason": close_reason,
                "event_id": payload.get("event_id"),
                "event_type": payload.get("event_type"),
                "ticker": ticker,
                "question": payload.get("question"),
                "created_at": state.created_at,
                "expires_at": state.expires_at,
                "settle_at": state.settle_at,
                "settlement_outcome": settlement_outcome,
            }
        )
        del active_events[ticker]


def _run_preopen_replay(scanner: Any, build_event_payload: Any, cfg: Config, id_counter: list[int]) -> None:
    assert cfg.backtest_time is not None
    open_utc = _market_open_utc(cfg.backtest_time)
    settle_utc = open_utc + timedelta(minutes=cfg.preopen_settle_minutes)
    sim_time = cfg.backtest_time
    tick_count = 0
    active_events: dict[str, ActiveEvent] = {}

    print(
        f"[scanner_events] REPLAY preopen start={_iso(cfg.backtest_time)} open={_iso(open_utc)} "
        f"settle={_iso(settle_utc)} "
        f"window={cfg.window_minutes}m step={cfg.step_minutes}m delay={cfg.replay_delay}s",
        file=sys.stderr,
    )

    while sim_time <= settle_utc and (cfg.max_ticks == 0 or tick_count < cfg.max_ticks):
        if sim_time < open_utc:
            if _in_preopen_window(sim_time, cfg.window_minutes):
                _create_preopen_events(scanner, build_event_payload, active_events, sim_time, cfg, id_counter)
            else:
                print(
                    f"[scanner_events] {_iso(sim_time)} outside preopen {cfg.window_minutes}-minute window.",
                    file=sys.stderr,
                )
        elif sim_time < settle_utc:
            pass
        else:
            _close_preopen_events(scanner, active_events, settle_utc)
            break

        tick_count += 1
        sim_time += timedelta(minutes=cfg.step_minutes)
        if cfg.replay_delay > 0 and sim_time <= settle_utc and (cfg.max_ticks == 0 or tick_count < cfg.max_ticks):
            time.sleep(cfg.replay_delay)

    if active_events:
        _close_preopen_events(scanner, active_events, settle_utc)

    print("[scanner_events] Replay complete.", file=sys.stderr)


def _run_preopen_live(scanner: Any, build_event_payload: Any, cfg: Config, id_counter: list[int]) -> None:
    active_events: dict[str, ActiveEvent] = {}
    print(
        f"[scanner_events] LIVE preopen mode | window={cfg.window_minutes}m | "
        f"poll={cfg.poll_seconds}s | settle={cfg.preopen_settle_minutes}m after open",
        file=sys.stderr,
    )
    while True:
        now = datetime.now(timezone.utc)
        open_utc = _market_open_utc(now)
        settle_utc = open_utc + timedelta(minutes=cfg.preopen_settle_minutes)
        window_start = open_utc - timedelta(minutes=cfg.window_minutes)

        if now >= open_utc:
            if now >= settle_utc:
                _close_preopen_events(scanner, active_events, settle_utc)
                print("[scanner_events] Closed all preopen events.", file=sys.stderr)
                return

            sleep_for = min(cfg.poll_seconds, max(1, int((settle_utc - now).total_seconds())))
            time.sleep(sleep_for)
            continue

        if now < window_start:
            sleep_for = min(cfg.poll_seconds, max(1, int((window_start - now).total_seconds())))
            print(
                f"[scanner_events] Waiting for preopen window at {_iso(window_start)} "
                f"(now {_iso(now)}).",
                file=sys.stderr,
            )
            time.sleep(sleep_for)
            continue

        _create_preopen_events(scanner, build_event_payload, active_events, now, cfg, id_counter)
        time.sleep(min(cfg.poll_seconds, max(1, int((open_utc - now).total_seconds()))))


def _build_intraday_source_payload(
    scanner: Any,
    ticker: str,
    volatility: float,
    as_of: datetime,
    cfg: Config,
    event_id: int,
) -> dict[str, Any] | None:
    snapshot = scanner.get_price_snapshot(ticker, as_of)
    if not snapshot:
        return None
    starting_price, starting_price_at = snapshot
    context, published_at, article_url = scanner.get_news(ticker, as_of, "spike")
    target_move_pct = _compute_intraday_target_move_pct(volatility, cfg)
    return {
        "event_id": event_id,
        "event_type": "intraday_volatility",
        "ticker": ticker,
        "volatility": float(volatility),
        "price": float(starting_price),
        "price_at": str(starting_price_at),
        "starting_price": float(starting_price),
        "starting_price_at": str(starting_price_at),
        "duration_seconds": int(cfg.intraday_duration_seconds),
        "target_move_pct": float(target_move_pct),
        "context": context,
        "published_at": published_at,
        "article_url": article_url,
    }


def _emit_intraday_event_created(state: ActiveEvent) -> None:
    payload = state.payload
    _emit(
        {
            "event": "event_created",
            "event_state": "active",
            "event_at": state.created_at,
            "expires_at": state.expires_at,
            "event_id": payload.get("event_id"),
            "event_type": payload.get("event_type"),
            "ticker": payload.get("ticker"),
            "question": payload.get("question"),
            "starting_price": payload.get("starting_price", payload.get("price")),
            "starting_price_at": payload.get("starting_price_at", payload.get("price_at")),
            "volatility": payload.get("volatility"),
            "target_move_pct": payload.get("target_move_pct"),
            "target_price": payload.get("target_price"),
            "duration_seconds": payload.get("duration_seconds"),
            "target_hit": state.target_hit,
            "context": payload.get("context"),
            "published_at": payload.get("published_at"),
            "article_url": payload.get("article_url"),
            "ai_summary": payload.get("ai_summary"),
        }
    )


def _intraday_metric(scanner: Any, ticker: str, as_of: datetime, start_price: float) -> dict[str, Any] | None:
    if start_price <= 0:
        return None
    start = as_of - timedelta(minutes=15)
    try:
        resp = requests.get(
            f"{scanner.ALPACA_BASE}/v2/stocks/{ticker}/bars",
            headers=scanner.HEADERS,
            params={
                "timeframe": "1Min",
                "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "limit": 1,
                "feed": "sip",
                "sort": "desc",
            },
            timeout=10,
        )
        resp.raise_for_status()
        bars = resp.json().get("bars", [])
        if not bars:
            return None
        bar = bars[0]
        close_price = float(bar.get("c", 0))
        high_price = float(bar.get("h", close_price))
        low_price = float(bar.get("l", close_price))
        price_at = str(bar.get("t", _iso(as_of)))
        if close_price <= 0 or high_price <= 0 or low_price <= 0:
            return None
    except Exception:
        return None

    move_from_start_pct = round((close_price - start_price) / start_price * 100, 4)
    return {
        "price": round(close_price, 4),
        "price_at": price_at,
        "bar_high": round(high_price, 4),
        "bar_low": round(low_price, 4),
        "move_from_start_pct": move_from_start_pct,
    }


def _update_intraday_progress(state: ActiveEvent, metric: dict[str, Any]) -> None:
    payload = state.payload
    start_price = float(payload.get("starting_price", payload.get("price", 0)))
    if start_price <= 0:
        return

    metric_time = str(metric.get("price_at", ""))
    start_time = str(payload.get("starting_price_at", payload.get("price_at", "")))
    allow_extrema = bool(metric_time and start_time and metric_time > start_time)

    if allow_extrema:
        high_price = float(metric.get("bar_high", metric["price"]))
        low_price = float(metric.get("bar_low", metric["price"]))
    else:
        # On the same start bar we only trust the close snapshot to avoid
        # counting moves that happened before event creation.
        high_price = float(metric["price"])
        low_price = float(metric["price"])

    state.max_price_seen = high_price if state.max_price_seen is None else max(state.max_price_seen, high_price)
    state.min_price_seen = low_price if state.min_price_seen is None else min(state.min_price_seen, low_price)

    if state.direction >= 0:
        best_move = ((state.max_price_seen - start_price) / start_price) * 100
        touched = allow_extrema and state.target_price is not None and high_price >= state.target_price
    else:
        best_move = ((start_price - state.min_price_seen) / start_price) * 100
        touched = allow_extrema and state.target_price is not None and low_price <= state.target_price

    state.max_favorable_move_pct = round(max(state.max_favorable_move_pct, best_move), 4)
    if touched and not state.target_hit:
        state.target_hit = True
        state.target_hit_at = str(metric.get("price_at"))


def _maybe_create_intraday_events(
    scanner: Any,
    build_event_payload: Any,
    active_events: dict[str, ActiveEvent],
    ticker_cooldown_until: dict[str, datetime],
    as_of: datetime,
    cfg: Config,
    id_counter: list[int],
) -> None:
    if not _in_regular_market_hours(as_of):
        return

    try:
        spikes = scanner.get_intraday_spikes(as_of)
    except Exception as exc:
        print(f"[scanner_events] Intraday scan failed at {_iso(as_of)}: {exc}", file=sys.stderr)
        return
    if not spikes:
        return

    for raw_ticker, volatility, _ in spikes:
        ticker = str(raw_ticker).upper()
        if ticker in active_events:
            continue

        cooldown_until = ticker_cooldown_until.get(ticker)
        if cooldown_until is not None and as_of < cooldown_until:
            continue

        event_id = _next_event_id(id_counter)
        source_payload = _build_intraday_source_payload(scanner, ticker, volatility, as_of, cfg, event_id)
        if not source_payload:
            continue
        try:
            created = build_event_payload(source_payload)
        except Exception as exc:
            print(f"[scanner_events] Intraday event creation failed for {ticker}: {exc}", file=sys.stderr)
            continue

        created["event_id"] = event_id
        created["event_type"] = "intraday_volatility"
        starting_price = float(created.get("starting_price", created.get("price", 0)))
        volatility_now = float(created.get("volatility", volatility))
        direction = 1 if volatility_now >= 0 else -1
        target_move_pct = abs(float(created.get("target_move_pct", cfg.intraday_target_move_pct)))
        target_multiplier = 1 + (target_move_pct / 100.0) * direction
        target_price = round(starting_price * target_multiplier, 4) if starting_price > 0 else None
        created["target_move_pct"] = target_move_pct
        created["target_price"] = target_price

        created_dt = as_of
        expires_dt = created_dt + timedelta(seconds=cfg.intraday_duration_seconds)
        state = ActiveEvent(
            payload=created,
            created_dt=created_dt,
            expires_dt=expires_dt,
            direction=direction,
            target_price=target_price,
            target_hit=False,
            target_hit_at=None,
            max_price_seen=starting_price if starting_price > 0 else None,
            min_price_seen=starting_price if starting_price > 0 else None,
            max_favorable_move_pct=0.0,
        )
        active_events[ticker] = state
        _emit_intraday_event_created(state)


def _emit_intraday_event_active(
    scanner: Any,
    active_events: dict[str, ActiveEvent],
    ticker_cooldown_until: dict[str, datetime],
    as_of: datetime,
    cfg: Config,
) -> None:
    for ticker in list(active_events.keys()):
        state = active_events.get(ticker)
        if state is None:
            continue

        payload = state.payload
        start_price = float(payload.get("starting_price", payload.get("price", 0)))
        metric = _intraday_metric(scanner, ticker, as_of, start_price)
        if not metric:
            continue
        _update_intraday_progress(state, metric)
        if state.target_hit:
            _close_intraday_event(
                scanner,
                active_events,
                ticker,
                as_of,
                cfg,
                ticker_cooldown_until,
                close_reason="target_hit",
                metric=metric,
            )
            continue

        _emit(
            {
                "event": "event_active",
                "event_state": "active",
                "event_at": _iso(as_of),
                "expires_at": state.expires_at,
                "event_id": payload.get("event_id"),
                "event_type": payload.get("event_type"),
                "ticker": ticker,
                "question": payload.get("question"),
                "starting_price": start_price,
                "starting_price_at": payload.get("starting_price_at", payload.get("price_at")),
                "price": metric["price"],
                "price_at": metric["price_at"],
                "move_from_start_pct": metric["move_from_start_pct"],
                "target_move_pct": payload.get("target_move_pct"),
                "target_price": state.target_price,
                "target_hit": state.target_hit,
                "context": payload.get("context"),
                "published_at": payload.get("published_at"),
                "article_url": payload.get("article_url"),
                "ai_summary": payload.get("ai_summary"),
            }
        )


def _close_intraday_event(
    scanner: Any,
    active_events: dict[str, ActiveEvent],
    ticker: str,
    close_time: datetime,
    cfg: Config,
    ticker_cooldown_until: dict[str, datetime],
    close_reason: str = "duration_elapsed",
    metric: dict[str, Any] | None = None,
) -> None:
    state = active_events.get(ticker)
    if state is None:
        return

    payload = state.payload
    settlement_outcome = "HIGHER" if state.direction >= 0 else "LOWER"

    _emit(
        {
            "event": "event_closed",
            "event_state": "closed",
            "event_at": _iso(close_time),
            "close_reason": close_reason,
            "event_id": payload.get("event_id"),
            "event_type": payload.get("event_type"),
            "ticker": ticker,
            "question": payload.get("question"),
            "created_at": state.created_at,
            "expires_at": state.expires_at,
            "settlement_outcome": settlement_outcome,
        }
    )
    del active_events[ticker]
    ticker_cooldown_until[ticker] = close_time + timedelta(seconds=cfg.intraday_ticker_cooldown_seconds)


def _run_intraday_replay(scanner: Any, build_event_payload: Any, cfg: Config, id_counter: list[int]) -> None:
    assert cfg.backtest_time is not None
    sim_time = cfg.backtest_time
    market_close = _market_close_utc(cfg.backtest_time)
    tick_count = 0
    active_events: dict[str, ActiveEvent] = {}
    ticker_cooldown_until: dict[str, datetime] = {}
    first_round_started = False

    print(
        f"[scanner_events] REPLAY intraday start={_iso(cfg.backtest_time)} close={_iso(market_close)} "
        f"step={cfg.intraday_step_seconds}s delay={cfg.replay_delay}s ttl={cfg.intraday_duration_seconds}s "
        f"cooldown={cfg.intraday_ticker_cooldown_seconds}s "
        f"target_mode={cfg.intraday_target_mode} target_fixed={cfg.intraday_target_move_pct:.2f}%",
        file=sys.stderr,
    )

    while sim_time <= market_close and (cfg.max_ticks == 0 or tick_count < cfg.max_ticks):
        for ticker in list(active_events.keys()):
            state = active_events.get(ticker)
            if state is not None and sim_time >= state.expires_dt:
                _close_intraday_event(
                    scanner,
                    active_events,
                    ticker,
                    state.expires_dt,
                    cfg,
                    ticker_cooldown_until,
                )
        if first_round_started and not active_events:
            print(
                "[scanner_events] First replay round completed (all stock events closed). Stopping replay.",
                file=sys.stderr,
            )
            break

        _maybe_create_intraday_events(
            scanner,
            build_event_payload,
            active_events,
            ticker_cooldown_until,
            sim_time,
            cfg,
            id_counter,
        )
        if not first_round_started and active_events:
            first_round_started = True
            print(
                f"[scanner_events] First replay round started with {len(active_events)} active stock events.",
                file=sys.stderr,
            )

        tick_count += 1
        sim_time += timedelta(seconds=cfg.intraday_step_seconds)
        if cfg.replay_delay > 0 and sim_time <= market_close and (cfg.max_ticks == 0 or tick_count < cfg.max_ticks):
            time.sleep(cfg.replay_delay)

    for ticker, state in list(active_events.items()):
        _close_intraday_event(
            scanner,
            active_events,
            ticker,
            state.expires_dt,
            cfg,
            ticker_cooldown_until,
        )

    print("[scanner_events] Replay complete.", file=sys.stderr)


def _run_intraday_live(scanner: Any, build_event_payload: Any, cfg: Config, id_counter: list[int]) -> None:
    active_events: dict[str, ActiveEvent] = {}
    ticker_cooldown_until: dict[str, datetime] = {}
    print(
        f"[scanner_events] LIVE intraday mode | poll={cfg.poll_seconds}s | "
        f"ttl={cfg.intraday_duration_seconds}s | cooldown={cfg.intraday_ticker_cooldown_seconds}s | "
        f"target_mode={cfg.intraday_target_mode} | target_fixed={cfg.intraday_target_move_pct:.2f}%",
        file=sys.stderr,
    )

    while True:
        now = datetime.now(timezone.utc)
        for ticker in list(active_events.keys()):
            state = active_events.get(ticker)
            if state is not None and now >= state.expires_dt:
                _close_intraday_event(
                    scanner,
                    active_events,
                    ticker,
                    state.expires_dt,
                    cfg,
                    ticker_cooldown_until,
                )

        _maybe_create_intraday_events(
            scanner,
            build_event_payload,
            active_events,
            ticker_cooldown_until,
            now,
            cfg,
            id_counter,
        )

        time.sleep(cfg.poll_seconds)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _dt_from_ms(value: Any) -> datetime:
    try:
        ms = int(float(value))
        if ms <= 0:
            raise ValueError
        return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    except (TypeError, ValueError):
        return _utc_now()


def _safe_market_id(session_id: str, source_event_id: str) -> str:
    raw = f"vision_{session_id}_{source_event_id}"
    out = []
    for ch in raw:
        if ch.isalnum() or ch in {"_", "-"}:
            out.append(ch)
        else:
            out.append("_")
    return "".join(out)


def _iter_vision_messages(path: str) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    if path:
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(f"VISION_INPUT file not found: {path}")

        raw = p.read_text(encoding="utf-8").strip()
        if not raw:
            return out

        if raw.startswith("["):
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, dict):
                        kind_payload = _classify_vision_message(item)
                        if kind_payload:
                            out.append(kind_payload)
            return out

        if raw.startswith("{"):
            try:
                one = json.loads(raw)
            except json.JSONDecodeError:
                one = None
            if isinstance(one, dict):
                kind_payload = _classify_vision_message(one)
                if kind_payload:
                    out.append(kind_payload)
                return out

        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            payload_line = _extract_json_payload_line(line)
            if payload_line is None:
                continue
            try:
                item = json.loads(payload_line)
            except json.JSONDecodeError:
                print(f"[scanner_events] Skipping invalid JSON line: {line[:120]}", file=sys.stderr)
                continue
            if isinstance(item, dict):
                kind_payload = _classify_vision_message(item)
                if kind_payload:
                    out.append(kind_payload)
        return out

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        payload_line = _extract_json_payload_line(line)
        if payload_line is None:
            continue
        try:
            item = json.loads(payload_line)
        except json.JSONDecodeError:
            print(f"[scanner_events] Skipping invalid stdin JSON line: {line[:120]}", file=sys.stderr)
            continue
        if isinstance(item, dict):
            kind_payload = _classify_vision_message(item)
            if kind_payload:
                out.append(kind_payload)
    return out


def _extract_json_payload_line(line: str) -> str | None:
    stripped = line.strip()
    if not stripped:
        return None

    if "payload=" in stripped:
        candidate = stripped.split("payload=", 1)[1].strip()
        if candidate.startswith("{") or candidate.startswith("["):
            return candidate
        return None

    if stripped.startswith("{") or stripped.startswith("["):
        return stripped
    return None


def _classify_vision_message(message: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    # wrapper formats
    if isinstance(message.get("starter"), dict):
        return "starter", message["starter"]
    if isinstance(message.get("resolution"), dict):
        return "resolution", message["resolution"]
    if isinstance(message.get("payload"), dict):
        nested = _classify_vision_message(message["payload"])
        if nested:
            return nested

    signal_type = str(message.get("signal_type", "")).strip().lower()
    if signal_type in {"starter", "start"}:
        return "starter", message
    if signal_type in {"resolution", "resolve", "closer"}:
        return "resolution", message

    # inferred raw payloads
    if "trigger_type" in message and "session_id" in message:
        return "starter", message
    if "market_id" in message and "outcome" in message:
        return "resolution", message

    print(f"[scanner_events] Ignoring unknown vision payload keys={list(message.keys())[:10]}", file=sys.stderr)
    return None


def _build_vision_source_payload(starter: dict[str, Any], event_id: int) -> tuple[str, dict[str, Any], datetime]:
    source_event_id = str(starter.get("event_id", "")).strip() or f"src_{event_id}"
    session_id = str(starter.get("session_id", "vision-session")).strip() or "vision-session"
    trigger_type = str(starter.get("trigger_type", "SAFETY_CAR_START")).strip().upper()
    created_dt = _dt_from_ms(starter.get("timestamp_ms"))
    duration_seconds = max(30, int(round(float(starter.get("market_duration_ms", 60_000)) / 1000.0)))
    confidence = float(starter.get("confidence", 0.0))
    confidence = max(0.0, min(1.0, confidence))

    context_obj = starter.get("context")
    if not isinstance(context_obj, dict):
        context_obj = {}
    line_laps = float(context_obj.get("market_line_laps", 3.5))
    if line_laps <= 0:
        line_laps = 3.5

    lap_start_raw = starter.get("lap", context_obj.get("lap_start"))
    lap_start = int(lap_start_raw) if isinstance(lap_start_raw, int) and lap_start_raw > 0 else None

    ocr_text = str(context_obj.get("ocr_text", "")).strip()
    context = f"{trigger_type} detected from live vision feed."
    if ocr_text:
        context = f"{context} OCR: {ocr_text[:220]}"

    market_id = str(starter.get("market_id", "")).strip() or _safe_market_id(session_id, source_event_id)

    payload = {
        "event_id": event_id,
        "event_type": "f1_safety_car_laps",
        "source_event_id": source_event_id,
        "session_id": session_id,
        "trigger_type": trigger_type,
        "lap_start": lap_start,
        "market_line_laps": line_laps,
        "duration_seconds": duration_seconds,
        "source_confidence": confidence,
        "context": context,
        "published_at": _iso(created_dt),
    }
    return market_id, payload, created_dt


def _emit_vision_event_active(state: ActiveEvent, as_of: datetime) -> None:
    payload = state.payload
    _emit(
        {
            "event": "event_active",
            "event_state": "active",
            "event_at": _iso(as_of),
            "expires_at": state.expires_at,
            "event_id": payload.get("event_id"),
            "event_type": payload.get("event_type"),
            "market_id": payload.get("market_id"),
            "session_id": payload.get("session_id"),
            "question": payload.get("question"),
            "trigger_type": payload.get("trigger_type"),
            "lap_start": payload.get("lap_start"),
            "market_line_laps": payload.get("market_line_laps"),
            "duration_seconds": payload.get("duration_seconds"),
            "source_confidence": payload.get("source_confidence"),
            "context": payload.get("context"),
            "published_at": payload.get("published_at"),
            "ai_summary": payload.get("ai_summary"),
        }
    )


def _close_vision_event(
    active_events: dict[str, ActiveEvent],
    market_id: str,
    close_dt: datetime,
    close_reason: str,
    resolution: dict[str, Any] | None = None,
) -> None:
    state = active_events.get(market_id)
    if state is None:
        return

    payload = state.payload
    outcome = None
    resolution_confidence = None
    resolution_context: dict[str, Any] | None = None
    if isinstance(resolution, dict):
        outcome_raw = resolution.get("outcome")
        if isinstance(outcome_raw, str) and outcome_raw.strip():
            outcome = outcome_raw.strip().upper()
        try:
            resolution_confidence = float(resolution.get("confidence"))
        except (TypeError, ValueError):
            resolution_confidence = None
        ctx = resolution.get("context")
        if isinstance(ctx, dict):
            resolution_context = ctx

    _emit(
        {
            "event": "event_closed",
            "event_state": "closed",
            "event_at": _iso(close_dt),
            "close_reason": close_reason,
            "event_id": payload.get("event_id"),
            "event_type": payload.get("event_type"),
            "market_id": payload.get("market_id"),
            "session_id": payload.get("session_id"),
            "question": payload.get("question"),
            "created_at": state.created_at,
            "expires_at": state.expires_at,
            "settlement_outcome": outcome,
            "resolution_confidence": resolution_confidence,
            "resolution_context": resolution_context,
        }
    )
    del active_events[market_id]


def _expire_vision_events(active_events: dict[str, ActiveEvent], as_of: datetime) -> None:
    for market_id in list(active_events.keys()):
        state = active_events.get(market_id)
        if state is None:
            continue
        if as_of >= state.expires_dt:
            _close_vision_event(
                active_events,
                market_id,
                state.expires_dt,
                close_reason="duration_elapsed",
                resolution=None,
            )


def _run_vision_mode(build_event_payload: Any, cfg: Config, id_counter: list[int]) -> None:
    active_events: dict[str, ActiveEvent] = {}
    source_to_market: dict[str, str] = {}

    src = cfg.vision_input if cfg.vision_input else "stdin"
    print(f"[scanner_events] VISION mode source={src}", file=sys.stderr)

    messages = _iter_vision_messages(cfg.vision_input)
    for signal_type, signal in messages:
        signal_time = _dt_from_ms(signal.get("timestamp_ms", signal.get("resolved_at_ms")))
        _expire_vision_events(active_events, signal_time)

        if signal_type == "starter":
            event_id = _next_event_id(id_counter)
            try:
                market_id, source_payload, created_dt = _build_vision_source_payload(signal, event_id)
                created = build_event_payload(source_payload)
            except Exception as exc:
                print(f"[scanner_events] Vision starter build failed: {exc}", file=sys.stderr)
                continue

            # Deduplicate while active: re-emit active instead of recreating.
            if market_id in active_events:
                _emit_vision_event_active(active_events[market_id], signal_time)
                continue

            duration_seconds = max(30, int(created.get("duration_seconds", source_payload["duration_seconds"])))
            expires_dt = created_dt + timedelta(seconds=duration_seconds)
            created["event_id"] = event_id
            created["event_type"] = "f1_safety_car_laps"
            created["market_id"] = market_id
            created["session_id"] = source_payload.get("session_id")
            created["source_event_id"] = source_payload.get("source_event_id")
            created["duration_seconds"] = duration_seconds

            state = ActiveEvent(
                payload=created,
                created_dt=created_dt,
                expires_dt=expires_dt,
            )
            active_events[market_id] = state
            source_event_id = str(source_payload.get("source_event_id", "")).strip()
            if source_event_id:
                source_to_market[source_event_id] = market_id

            _emit(
                {
                    "event": "event_created",
                    "event_state": "active",
                    "event_at": state.created_at,
                    "expires_at": state.expires_at,
                    "event_payload": created,
                }
            )
            _emit_vision_event_active(state, signal_time)
            continue

        # resolution
        market_id = str(signal.get("market_id", "")).strip()
        if not market_id:
            source_event_id = str(signal.get("event_id", "")).strip()
            market_id = source_to_market.get(source_event_id, "")

        if not market_id:
            print(
                f"[scanner_events] Vision resolution skipped (unknown market): keys={list(signal.keys())[:10]}",
                file=sys.stderr,
            )
            continue

        close_dt = _dt_from_ms(signal.get("resolved_at_ms"))
        reason = str(signal.get("reason", "vision_signal")).strip() or "vision_signal"
        _close_vision_event(
            active_events,
            market_id,
            close_dt,
            close_reason=reason,
            resolution=signal,
        )
        _expire_vision_events(active_events, close_dt)

    # Any unresolved active events are force-closed when input completes.
    if active_events:
        now = _utc_now()
        for market_id in list(active_events.keys()):
            _close_vision_event(
                active_events,
                market_id,
                now,
                close_reason="stream_complete",
                resolution=None,
            )

    print("[scanner_events] Vision stream complete.", file=sys.stderr)


def main() -> None:
    _bootstrap_env()
    args = _parse_args()
    scanner, pipeline = _import_modules()
    cfg = _build_config(scanner, args)
    _set_emit_api_base_url(cfg.api_base_url)

    scanner.PREOPEN_WINDOW = cfg.window_minutes
    scanner.BACKTEST_TIME_STR = cfg.backtest_time_str
    if cfg.api_base_url:
        print(
            f"[scanner_events] API emit enabled -> {_normalize_api_base_url(cfg.api_base_url)}/scanner/events",
            file=sys.stderr,
        )

    as_of = cfg.backtest_time if cfg.backtest_time else datetime.now(timezone.utc)
    resolved_mode = _resolve_mode(cfg.mode, as_of, cfg.window_minutes)
    build_event_payload = pipeline.build_event_payload
    id_counter = [cfg.event_id_start]

    if resolved_mode == "vision":
        _run_vision_mode(build_event_payload, cfg, id_counter)
        return

    if cfg.backtest_time:
        if resolved_mode == "preopen":
            _run_preopen_replay(scanner, build_event_payload, cfg, id_counter)
        else:
            _run_intraday_replay(scanner, build_event_payload, cfg, id_counter)
    else:
        if resolved_mode == "preopen":
            _run_preopen_live(scanner, build_event_payload, cfg, id_counter)
        else:
            _run_intraday_live(scanner, build_event_payload, cfg, id_counter)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[scanner_events] Stopped.", file=sys.stderr)
        sys.exit(0)
