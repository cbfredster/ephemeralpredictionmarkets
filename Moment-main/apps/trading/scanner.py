"""
Volatility Spike Scanner
--------------------------
Two scanner session modes:

1. INTRADAY SESSION (SESSION_MODE=intraday)
   Runs classic spike/gap detection on every poll.

   a) INTRADAY SPIKE  — price moved >= SPIKE_THRESHOLD % in the last SPIKE_WINDOW minutes
                        (catches rapid intraday shocks mid-session)

   b) OPENING GAP     — today's open is >= GAP_THRESHOLD % away from yesterday's close
                        (catches Liberation Day / tariff-announcement-style gap opens)
                        Only fires within the first 30 minutes of market open.

2. PREOPEN SESSION (SESSION_MODE=preopen)
   Scans only during PREOPEN_WINDOW minutes before 13:30 UTC and ranks stocks with:
   - high preopen move vs prior close
   - high preopen dollar volume (liquidity)
   Also outputs prior close and official opening price when available.

Combined, these catch every type of violent move:
  - Sudden intraday shock (Fed decision, surprise earnings, breaking news)
  - Massive gap-down/up at open (overnight macro event like tariff announcements)

Output per triggered ticker:
  {
    "ticker": "TSLA",
    "bet_type": "intraday_volatility",  // or "preopen_volatility"
    "volatility": -4.12,        // % move (negative = crash)
    "price": 187.43,            // latest 1-min close at/before scan time
    "price_at": "2025-04-03T13:32:00Z",
    "context": "Headline…",
    "published_at": "2025-04-03T13:32:00Z"
  }
  // preopen_volatility payload also includes: "article_url"

.env config:
  ALPACA_API_KEY       – required
  ALPACA_SECRET_KEY    – required
  SESSION_MODE         – intraday | preopen | auto (default: intraday)
  SPIKE_THRESHOLD      – intraday |% change| in window to trigger (default: 1.5)
  SPIKE_WINDOW         – lookback minutes for intraday spike (default: 5)
  GAP_THRESHOLD        – opening gap |% vs prev close| to trigger (default: 2.0)
  PREOPEN_WINDOW       – minutes before open to scan (default: 10)
  PREOPEN_THRESHOLD    – min |% vs prev close| to flag (default: 1.0)
  PREOPEN_RANGE_THRESHOLD – min overnight range % vs prev close (default: 1.5)
  PREOPEN_MIN_DOLLAR_VOLUME – min preopen $ volume in window (default: 2500000)
  PREOPEN_MAX_RESULTS  – max preopen candidates per scan (default: 8)
  POLL_INTERVAL        – seconds between polls, live mode only (default: 30)
  BACKTEST_TIME        – ISO datetime to replay. Unset = live mode.
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

# Load env from repo root first, then local fallback.
REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env")

ALPACA_API_KEY    = os.getenv("ALPACA_API_KEY")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY")
FINNHUB_API_KEY   = os.getenv("FINNHUB_API_KEY", "").strip()
SESSION_MODE      = os.getenv("SESSION_MODE", "intraday").strip().lower()
SPIKE_THRESHOLD   = float(os.getenv("SPIKE_THRESHOLD", "1.5"))
SPIKE_WINDOW      = int(os.getenv("SPIKE_WINDOW", "5"))
GAP_THRESHOLD     = float(os.getenv("GAP_THRESHOLD", "2.0"))
PREOPEN_WINDOW    = int(os.getenv("PREOPEN_WINDOW", "10"))
PREOPEN_THRESHOLD = float(os.getenv("PREOPEN_THRESHOLD", "1.0"))
PREOPEN_RANGE_THRESHOLD = float(os.getenv("PREOPEN_RANGE_THRESHOLD", "1.5"))
PREOPEN_MIN_DOLLAR_VOLUME = float(os.getenv("PREOPEN_MIN_DOLLAR_VOLUME", "2500000"))
PREOPEN_MAX_RESULTS = int(os.getenv("PREOPEN_MAX_RESULTS", "8"))
POLL_INTERVAL     = int(os.getenv("POLL_INTERVAL", "30"))
BACKTEST_TIME_STR = os.getenv("BACKTEST_TIME", "").strip()
BACKTEST_STEP     = int(os.getenv("BACKTEST_STEP", "5"))   # sim minutes per tick
REPLAY_DELAY      = int(os.getenv("REPLAY_DELAY", "0"))    # real seconds to sleep between ticks
REPLAY_TICKS      = int(os.getenv("REPLAY_TICKS", "0"))    # max ticks (0 = full day)

if SESSION_MODE not in {"intraday", "preopen", "auto"}:
    print(f"[warn] Unknown SESSION_MODE '{SESSION_MODE}', defaulting to 'intraday'.", file=sys.stderr)
    SESSION_MODE = "intraday"

if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
    print(json.dumps({"error": "ALPACA_API_KEY and ALPACA_SECRET_KEY must be set in .env"}), file=sys.stderr)
    sys.exit(1)

ALPACA_BASE = "https://data.alpaca.markets"
HEADERS = {
    "APCA-API-KEY-ID": ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
}

WATCHLIST = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"
]

DEBOUNCE_SECONDS = 300
_last_fired: dict[str, float] = {}


def parse_backtest_time() -> datetime | None:
    if not BACKTEST_TIME_STR:
        return None
    try:
        dt = datetime.fromisoformat(BACKTEST_TIME_STR.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc)
    except ValueError:
        print(f"[error] Invalid BACKTEST_TIME '{BACKTEST_TIME_STR}'. Use ISO format: 2025-04-03T13:40:00Z", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Detection 1: Intraday spike via 1-minute bars
# ---------------------------------------------------------------------------

def get_intraday_spikes(as_of: datetime) -> list[tuple[str, float, str]]:
    """Returns [(ticker, pct, 'spike')] for intraday moves >= SPIKE_THRESHOLD."""
    start = as_of - timedelta(minutes=SPIKE_WINDOW + 5)
    # Alpaca's multi-symbol bars endpoint applies `limit` to the combined result set,
    # not per ticker. If limit is too small, we can accidentally only see one symbol
    # (often AAPL first alphabetically), so size it across the full watchlist.
    limit_per_symbol = SPIKE_WINDOW + 2
    total_limit = min(10000, max(limit_per_symbol * len(WATCHLIST), limit_per_symbol))
    resp = requests.get(
        f"{ALPACA_BASE}/v2/stocks/bars",
        headers=HEADERS,
        params={
            "symbols":   ",".join(WATCHLIST),
            "timeframe": "1Min",
            "start":     start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end":       as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "limit":     total_limit,
            "feed":      "sip",
            "sort":      "asc",
        },
        timeout=15,
    )
    resp.raise_for_status()

    now_ts = time.time()
    results = []
    for ticker, bars in resp.json().get("bars", {}).items():
        if len(bars) < 2:
            continue
        o, c = bars[0]["o"], bars[-1]["c"]
        if o <= 0:
            continue
        pct = round((c - o) / o * 100, 4)
        if abs(pct) < SPIKE_THRESHOLD:
            continue
        if not BACKTEST_TIME_STR and now_ts - _last_fired.get(ticker, 0) < DEBOUNCE_SECONDS:
            continue
        results.append((ticker, pct, "spike"))

    results.sort(key=lambda x: abs(x[1]), reverse=True)
    return results


# ---------------------------------------------------------------------------
# Detection 2: Opening gap vs prior close (via daily bars)
# ---------------------------------------------------------------------------

def get_gap_spikes(as_of: datetime) -> list[tuple[str, float, str]]:
    """
    Returns [(ticker, gap_pct, 'gap')] for tickers whose opening price today
    gapped >= GAP_THRESHOLD % vs the prior session's close.
    Only meaningful within the first 30 minutes of market open (13:30–14:00 UTC).
    """
    # Market open window: 13:30–14:00 UTC
    market_open_utc = as_of.replace(hour=13, minute=30, second=0, microsecond=0)
    if not (market_open_utc <= as_of <= market_open_utc + timedelta(minutes=30)):
        return []

    start = (as_of - timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end   = as_of.strftime("%Y-%m-%dT%H:%M:%SZ")

    def fetch_ticker_bars(ticker: str) -> tuple[str, list]:
        """Fetch daily bars for a single ticker. Returns (ticker, bars_list)."""
        try:
            resp = requests.get(
                f"{ALPACA_BASE}/v2/stocks/{ticker}/bars",
                headers=HEADERS,
                params={"timeframe": "1Day", "start": start, "end": end,
                        "feed": "sip", "sort": "asc"},
                timeout=10,
            )
            resp.raise_for_status()
            return ticker, resp.json().get("bars", [])
        except Exception:
            return ticker, []

    # Fetch all tickers in parallel (max 10 concurrent to respect rate limits)
    from concurrent.futures import ThreadPoolExecutor, as_completed
    now_ts  = time.time()
    results = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(fetch_ticker_bars, t): t for t in WATCHLIST}
        for future in as_completed(futures):
            ticker, bars = future.result()
            if len(bars) < 2:
                continue
            prev_close = bars[-2]["c"]
            today_open = bars[-1]["o"]
            if prev_close <= 0:
                continue
            gap_pct = round((today_open - prev_close) / prev_close * 100, 4)
            if abs(gap_pct) < GAP_THRESHOLD:
                continue
            fired_key = f"{ticker}_gap"
            if not BACKTEST_TIME_STR and now_ts - _last_fired.get(fired_key, 0) < DEBOUNCE_SECONDS:
                continue
            results.append((ticker, gap_pct, "gap"))

    results.sort(key=lambda x: abs(x[1]), reverse=True)
    return results


def market_open_utc(as_of: datetime) -> datetime:
    return as_of.replace(hour=13, minute=30, second=0, microsecond=0)


def in_preopen_window(as_of: datetime) -> bool:
    open_utc = market_open_utc(as_of)
    window_start = open_utc - timedelta(minutes=PREOPEN_WINDOW)
    return window_start <= as_of < open_utc


def overnight_window_start_utc(as_of: datetime) -> datetime:
    """
    Start of overnight tracking window for the current session.
    US regular session close is 20:00 UTC (4:00pm ET).
    """
    return market_open_utc(as_of) - timedelta(hours=17, minutes=30)


def resolve_session_mode(as_of: datetime) -> str:
    if SESSION_MODE == "preopen":
        return "preopen"
    if SESSION_MODE == "auto":
        return "preopen" if in_preopen_window(as_of) else "intraday"
    return "intraday"


def get_daily_reference_prices(as_of: datetime) -> dict[str, tuple[float, float | None]]:
    """
    Returns {ticker: (prev_close, today_open_or_none)} for watchlist tickers.
    Before regular open (13:30 UTC), today_open is forced to None to avoid lookahead.
    """
    start = (as_of - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end = as_of.strftime("%Y-%m-%dT%H:%M:%SZ")
    session_day = as_of.strftime("%Y-%m-%d")

    # Multi-symbol bars `limit` is applied to the combined result set, so size it
    # across the full watchlist to avoid only receiving a subset of symbols.
    daily_limit_per_symbol = 8
    daily_total_limit = min(10000, max(daily_limit_per_symbol * len(WATCHLIST), daily_limit_per_symbol))

    resp = requests.get(
        f"{ALPACA_BASE}/v2/stocks/bars",
        headers=HEADERS,
        params={
            "symbols": ",".join(WATCHLIST),
            "timeframe": "1Day",
            "start": start,
            "end": end,
            "limit": daily_total_limit,
            "feed": "sip",
            "sort": "asc",
        },
        timeout=15,
    )
    resp.raise_for_status()

    refs: dict[str, tuple[float, float | None]] = {}
    for ticker, bars in resp.json().get("bars", {}).items():
        if not bars:
            continue
        session_idx = next(
            (i for i, bar in enumerate(bars) if str(bar.get("t", ""))[:10] == session_day),
            None,
        )

        if session_idx is None:
            # If today's bar is unavailable, use latest known close as prev close.
            prev_close = float(bars[-1].get("c", 0))
            today_open = None
        else:
            if session_idx == 0:
                continue
            prev_close = float(bars[session_idx - 1].get("c", 0))
            maybe_open = float(bars[session_idx].get("o", 0))
            today_open = maybe_open if (as_of >= market_open_utc(as_of) and maybe_open > 0) else None

        if prev_close <= 0:
            continue
        refs[ticker] = (prev_close, today_open)
    return refs


def get_preopen_candidates(as_of: datetime) -> list[dict]:
    """
    Returns preopen movers using full overnight activity, filtered for "crazy" setups:
      - large move vs prior close
      - large overnight range
      - strong overnight dollar volume

    Output item:
      {
        "ticker": "NVDA",
        "volatility": 2.14,
        "preopen_price": 174.6,
        "price_at": "2025-09-18T13:29:00Z",
        "close_price": 170.29,
        "dollar_volume": 5123456.12
      }
    """
    if not in_preopen_window(as_of):
        return []

    window_start = overnight_window_start_utc(as_of)
    refs = get_daily_reference_prices(as_of)
    bars_by_ticker: dict[str, list[dict]] = {}

    def fetch_ticker_bars(ticker: str) -> tuple[str, list[dict]]:
        try:
            resp = requests.get(
                f"{ALPACA_BASE}/v2/stocks/{ticker}/bars",
                headers=HEADERS,
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
        futures = {pool.submit(fetch_ticker_bars, ticker): ticker for ticker in WATCHLIST}
        for future in as_completed(futures):
            ticker, bars = future.result()
            bars_by_ticker[ticker] = bars

    now_ts = time.time()
    results: list[dict] = []

    for ticker, bars in bars_by_ticker.items():
        if not bars or ticker not in refs:
            continue
        prev_close, _ = refs[ticker]
        latest = bars[-1]
        latest_price = float(latest.get("c", 0))
        if latest_price <= 0:
            continue

        volatility = round((latest_price - prev_close) / prev_close * 100, 4)
        if abs(volatility) < PREOPEN_THRESHOLD:
            continue

        overnight_high = max(float(bar.get("h", 0)) for bar in bars)
        overnight_low = min(float(bar.get("l", 0)) for bar in bars)
        if overnight_high <= 0 or overnight_low <= 0:
            continue
        overnight_range_pct = round((overnight_high - overnight_low) / prev_close * 100, 4)
        if overnight_range_pct < PREOPEN_RANGE_THRESHOLD:
            continue

        dollar_volume = float(sum(float(bar.get("c", 0)) * float(bar.get("v", 0)) for bar in bars))
        if dollar_volume < PREOPEN_MIN_DOLLAR_VOLUME:
            continue

        fired_key = f"{ticker}_preopen"
        if not BACKTEST_TIME_STR and now_ts - _last_fired.get(fired_key, 0) < DEBOUNCE_SECONDS:
            continue

        results.append({
            "ticker": ticker,
            "volatility": volatility,
            "preopen_price": round(latest_price, 4),
            "price_at": latest.get("t", as_of.strftime("%Y-%m-%dT%H:%M:%SZ")),
            "close_price": round(prev_close, 4),
            "dollar_volume": round(dollar_volume, 2),
            "overnight_range_pct": overnight_range_pct,
        })

    results.sort(
        key=lambda x: (abs(x["volatility"]), x["overnight_range_pct"], x["dollar_volume"]),
        reverse=True,
    )
    return results[:max(1, PREOPEN_MAX_RESULTS)]



# ---------------------------------------------------------------------------
# News fetch — multi-source, anchored to as_of time
# ---------------------------------------------------------------------------
#
# Strategy by trigger type:
#   gap   → Finnhub general market news first (Reuters/AP/Bloomberg wire),
#           then Alpaca general, then Alpaca ticker-specific.
#   spike → Alpaca ticker-specific first (stock event),
#           then Finnhub company news, then Alpaca general.
# ---------------------------------------------------------------------------

FINNHUB_BASE = "https://finnhub.io/api/v1"

def _finnhub_general_news(as_of: datetime, lookback_days: int) -> tuple[str, str, str | None] | None:
    """
    Fetches the most relevant market-wide news before *as_of* from Finnhub.

    Live mode  (as_of ≈ now): uses Finnhub's live general news feed, filtered by timestamp.
    Backtest   (as_of in past): general feed has no date range, so we use company-news
                                 on SPY as a macro proxy — it carries broad market/macro articles.
    """
    if not FINNHUB_API_KEY:
        return None
    try:
        cutoff   = as_of.timestamp()
        earliest = (as_of - timedelta(days=lookback_days)).timestamp()
        now_ts   = datetime.now(timezone.utc).timestamp()
        is_live  = (now_ts - cutoff) < 86400  # within the last 24 h → live mode

        if is_live:
            # Live: pull general feed and filter by timestamp
            resp = requests.get(
                f"{FINNHUB_BASE}/news",
                params={"category": "general", "token": FINNHUB_API_KEY},
                timeout=10,
            )
            resp.raise_for_status()
            articles = [a for a in resp.json() if earliest <= a.get("datetime", 0) <= cutoff]
        else:
            # Backtest: use date-ranged company-news on SPY (macro proxy)
            date_from = (as_of - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
            date_to   = as_of.strftime("%Y-%m-%d")
            resp = requests.get(
                f"{FINNHUB_BASE}/company-news",
                params={"symbol": "SPY", "from": date_from, "to": date_to, "token": FINNHUB_API_KEY},
                timeout=10,
            )
            resp.raise_for_status()
            articles = [a for a in resp.json() if earliest <= a.get("datetime", 0) <= cutoff]

        if not articles:
            return None

        # Score: prefer macro/market-impacting headlines
        macro_words = {
            "tariff", "trade", "fed", "rate", "inflation", "recession",
            "sanction", "gdp", "market", "economy", "crash", "rally",
            "selloff", "plunge", "surge", "trump", "white house", "treasury",
        }
        def score(art: dict) -> int:
            text = (art.get("headline", "") + " " + art.get("summary", "")).lower()
            return sum(1 for w in macro_words if w in text)

        best = max(articles, key=lambda a: (score(a), a.get("datetime", 0)))
        headline     = best.get("headline", "No headline available.")
        published_at = datetime.fromtimestamp(best["datetime"], tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        article_url  = best.get("url")
        return headline, published_at, article_url

    except Exception:
        pass
    return None



def _finnhub_company_news(ticker: str, as_of: datetime, lookback_days: int) -> tuple[str, str, str | None] | None:
    """Finnhub company news for ticker before as_of, ranked by earnings-relevance then recency."""
    if not FINNHUB_API_KEY:
        return None
    try:
        start = (as_of - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
        end   = as_of.strftime("%Y-%m-%d")
        resp = requests.get(
            f"{FINNHUB_BASE}/company-news",
            params={"symbol": ticker, "from": start, "to": end, "token": FINNHUB_API_KEY},
            timeout=10,
        )
        resp.raise_for_status()
        cutoff   = as_of.timestamp()
        articles = [a for a in resp.json() if a.get("datetime", 0) <= cutoff]
        if not articles:
            return None

        # Prioritise headlines that describe the actual event over morning preview notes
        impact_words = {
            "earnings", "beat", "beats", "revenue", "guidance", "record",
            "outlook", "quarter", "results", "profit", "eps", "forecast",
            "raised", "upgraded", "downgraded", "sales", "growth",
        }
        def score(art: dict) -> tuple[int, int]:
            text = (art.get("headline", "") + " " + art.get("summary", "")).lower()
            relevance = sum(1 for w in impact_words if w in text)
            return (relevance, art.get("datetime", 0))  # relevance first, recency as tiebreaker

        best = max(articles, key=score)
        headline     = best.get("headline", "No headline available.")
        published_at = datetime.fromtimestamp(best["datetime"], tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        article_url  = best.get("url")
        return headline, published_at, article_url
    except Exception:
        pass
    return None


def _alpaca_news(ticker: str | None, as_of: datetime, lookback_days: int) -> tuple[str, str, str | None] | None:
    """Alpaca news, optionally filtered by ticker. Fetches up to 10 and returns the most relevant."""
    start = as_of - timedelta(days=lookback_days)
    params: dict = {
        "limit": 10,
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end":   as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sort":  "desc",
    }
    if ticker:
        params["symbols"] = ticker
    try:
        resp = requests.get(f"{ALPACA_BASE}/v1beta1/news", headers=HEADERS, params=params, timeout=10)
        resp.raise_for_status()
        raw = resp.json()
        articles = raw.get("news", raw) if isinstance(raw, dict) else raw
        if not articles:
            return None

        # Score articles: prefer those mentioning the ticker or macro terms
        macro_words = {
            "tariff", "trade", "fed", "rate", "inflation", "recession",
            "sanction", "gdp", "earnings", "guidance", "crash", "rally",
            "selloff", "plunge", "surge", "market", "economy",
        }
        def score(art: dict) -> int:
            text = (art.get("headline", "") + " " + art.get("summary", "")).lower()
            s = 0
            if ticker and ticker.lower() in text:
                s += 3
            s += sum(1 for w in macro_words if w in text)
            return s

        best = max(articles, key=score)
        return (
            best.get("headline", best.get("title", "No headline available.")),
            best.get("created_at", best.get("published_at", "Unknown")),
            best.get("url"),
        )
    except Exception:
        pass
    return None



def get_news(ticker: str, as_of: datetime, trigger: str = "spike") -> tuple[str, str, str | None]:
    """
    Returns (headline, published_at, article_url) using the best available source.

    gap   → Finnhub general → Alpaca general → Alpaca ticker
    spike → Alpaca ticker   → Finnhub company → Alpaca general

    For gap events the news window ends at market open (13:30 UTC), not at
    as_of — so we only see pre-open news that actually caused the gap.
    """
    lookback = 7 if trigger == "gap" else 3

    # Gap news must predate the open — cap end at 13:30 UTC on the same day
    if trigger == "gap":
        news_end = as_of.replace(hour=13, minute=30, second=0, microsecond=0)
    else:
        news_end = as_of

    if trigger == "gap":
        sources = [
            lambda: _finnhub_general_news(news_end, lookback),
            lambda: _finnhub_company_news(ticker, news_end, lookback),  # earnings gaps
            lambda: _alpaca_news(ticker, news_end, lookback),
            lambda: _alpaca_news(None, news_end, lookback),
        ]
    else:
        sources = [
            lambda: _alpaca_news(ticker, news_end, lookback),
            lambda: _finnhub_company_news(ticker, news_end, lookback),
            lambda: _alpaca_news(None, news_end, lookback),
        ]


    for source in sources:
        result = source()
        if result:
            return result

    return "No recent news available.", "Unknown", None


# ---------------------------------------------------------------------------
# Single scan pass
# ---------------------------------------------------------------------------

def get_price_snapshot(ticker: str, as_of: datetime) -> tuple[float, str] | None:
    """
    Returns (price, bar_time) using the latest 1-minute bar at or before as_of.
    """
    start = as_of - timedelta(minutes=15)
    try:
        resp = requests.get(
            f"{ALPACA_BASE}/v2/stocks/{ticker}/bars",
            headers=HEADERS,
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
        bar_time = bar.get("t", "Unknown")
        if close_price <= 0:
            return None
        return round(close_price, 4), bar_time
    except Exception:
        return None

def run_intraday_once(as_of: datetime) -> None:
    now_ts = time.time()
    all_spikes = get_intraday_spikes(as_of) + get_gap_spikes(as_of)

    # Deduplicate: if same ticker fires both modes, keep the bigger move
    seen: dict[str, tuple[str, float, str]] = {}
    for ticker, pct, trigger in all_spikes:
        if ticker not in seen or abs(pct) > abs(seen[ticker][1]):
            seen[ticker] = (ticker, pct, trigger)

    ordered = sorted(seen.values(), key=lambda x: abs(x[1]), reverse=True)
    if ordered:
        for ticker, volatility, trigger in ordered:
            context, published_at, _ = get_news(ticker, as_of, trigger)
            snapshot = get_price_snapshot(ticker, as_of)
            price = snapshot[0] if snapshot else None
            price_at = snapshot[1] if snapshot else as_of.strftime("%Y-%m-%dT%H:%M:%SZ")
            print(json.dumps({
                "ticker":       ticker,
                "bet_type":     "intraday_volatility",
                "volatility":   volatility,
                "price":        price,
                "price_at":     price_at,
                "context":      context,
                "published_at": published_at,
            }, indent=2), flush=True)
            _last_fired[ticker] = now_ts
            _last_fired[f"{ticker}_gap"] = now_ts
    else:
        print(
            f"[{as_of.strftime('%Y-%m-%dT%H:%M:%SZ')}] Quiet — "
            f"no spikes >= {SPIKE_THRESHOLD}% or gaps >= {GAP_THRESHOLD}%.",
            file=sys.stderr,
        )


def run_preopen_once(as_of: datetime) -> None:
    now_ts = time.time()
    candidates = get_preopen_candidates(as_of)

    if candidates:
        for item in candidates:
            ticker = item["ticker"]
            context, published_at, article_url = get_news(ticker, as_of, "gap")
            print(json.dumps({
                "ticker": ticker,
                "bet_type": "preopen_volatility",
                "volatility": item["volatility"],
                "price": item["preopen_price"],
                "price_at": item["price_at"],
                "close_price": item["close_price"],
                "dollar_volume": item["dollar_volume"],
                "context": context,
                "published_at": published_at,
                "article_url": article_url,
            }, indent=2), flush=True)
            _last_fired[f"{ticker}_preopen"] = now_ts
    else:
        open_utc = market_open_utc(as_of)
        start_utc = open_utc - timedelta(minutes=PREOPEN_WINDOW)
        if start_utc <= as_of < open_utc:
            print(
                f"[{as_of.strftime('%Y-%m-%dT%H:%M:%SZ')}] Quiet — "
                f"no preopen movers >= {PREOPEN_THRESHOLD}% move, "
                f"{PREOPEN_RANGE_THRESHOLD}% overnight range, and "
                f"${PREOPEN_MIN_DOLLAR_VOLUME:,.0f}+ volume.",
                file=sys.stderr,
            )
        else:
            print(
                f"[{as_of.strftime('%Y-%m-%dT%H:%M:%SZ')}] Outside preopen window "
                f"({start_utc.strftime('%H:%MZ')}–{open_utc.strftime('%H:%MZ')}).",
                file=sys.stderr,
            )


def run_once(as_of: datetime) -> None:
    mode = resolve_session_mode(as_of)
    if mode == "preopen":
        run_preopen_once(as_of)
    else:
        run_intraday_once(as_of)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    backtest_time = parse_backtest_time()

    if backtest_time:
        # ── Backtest replay loop ───────────────────────────────────────────
        # Walk forward from BACKTEST_TIME to market close (20:00 UTC = 4pm ET)
        market_close = backtest_time.replace(hour=20, minute=0, second=0, microsecond=0)
        sim_time = backtest_time
        total_ticks = int((market_close - sim_time).total_seconds() / 60 / BACKTEST_STEP)

        max_ticks   = REPLAY_TICKS if REPLAY_TICKS > 0 else total_ticks + 1
        tick_count  = 0
        ticks_label = "∞" if REPLAY_TICKS == 0 else str(REPLAY_TICKS)

        print(
            f"[scanner] REPLAY — {sim_time.strftime('%Y-%m-%dT%H:%M:%SZ')} "
            f"\u2192 {market_close.strftime('%H:%MZ')} | "
            f"step: {BACKTEST_STEP}min | ticks: {ticks_label} | "
            f"delay: {REPLAY_DELAY}s | mode: {SESSION_MODE} | "
            f"spike: {SPIKE_THRESHOLD}%/{SPIKE_WINDOW}min | gap: {GAP_THRESHOLD}% | "
            f"preopen: move>={PREOPEN_THRESHOLD}% | range>={PREOPEN_RANGE_THRESHOLD}% | "
            f"window={PREOPEN_WINDOW}min | vol=${PREOPEN_MIN_DOLLAR_VOLUME:,.0f}",
            file=sys.stderr,
        )

        while sim_time <= market_close and tick_count < max_ticks:
            try:
                run_once(sim_time)
            except Exception as exc:
                print(f"[error @ {sim_time.strftime('%H:%MZ')}] {exc}", file=sys.stderr)
            sim_time  += timedelta(minutes=BACKTEST_STEP)
            tick_count += 1
            if REPLAY_DELAY > 0 and sim_time <= market_close and tick_count < max_ticks:
                print(
                    f"[{sim_time.strftime('%H:%MZ')} sim] Next tick in {REPLAY_DELAY}s...",
                    file=sys.stderr,
                )
                time.sleep(REPLAY_DELAY)

        print("[scanner] Replay complete.", file=sys.stderr)

    else:
        # ── Live mode ─────────────────────────────────────────────────────
        print(
            f"[scanner] LIVE — {len(WATCHLIST)} tickers | "
            f"mode: {SESSION_MODE} | "
            f"spike: {SPIKE_THRESHOLD}%/{SPIKE_WINDOW}min | "
            f"gap: {GAP_THRESHOLD}% | "
            f"preopen: move>={PREOPEN_THRESHOLD}% | range>={PREOPEN_RANGE_THRESHOLD}% | "
            f"window={PREOPEN_WINDOW}min | vol=${PREOPEN_MIN_DOLLAR_VOLUME:,.0f} | "
            f"poll: {POLL_INTERVAL}s",
            file=sys.stderr,
        )
        while True:
            try:
                run_once(datetime.now(timezone.utc))
            except Exception as exc:
                print(f"[error] {exc}", file=sys.stderr)
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[scanner] Stopped.", file=sys.stderr)
        sys.exit(0)
