from __future__ import annotations

import argparse
import importlib
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import cv2

from config import SafetyCarLapsConfig
from detectors.yellow_flag import OcrReader, YellowFlagDetector
from market_client import MarketClient
from schemas import ResolutionSignal, StarterSignal
from trigger_fsm import TriggerFSM


@dataclass
class ActiveSafetyCarMarket:
    market_id: str
    event_id: str
    lap_start: int | None
    t_start_s: float


def now_ms() -> int:
    return int(time.time() * 1000)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="F1 Safety Car laps market agent.")
    parser.add_argument("--source", default=0, help="Video source: webcam index, file path, or RTSP URL.")
    parser.add_argument("--api-base-url", default="http://127.0.0.1:4000", help="Moment API base URL.")
    parser.add_argument("--session-id", required=True, help="Unique session id for this feed.")
    parser.add_argument("--fps", type=float, default=5.0, help="Processing FPS target.")
    parser.add_argument(
        "--sample-fps",
        type=float,
        default=None,
        help="Sampled processing FPS for file sources (for faster-than-realtime offline analysis).",
    )
    parser.add_argument(
        "--realtime-file",
        action="store_true",
        help="Throttle local file playback to wall-clock time (1x by default).",
    )
    parser.add_argument(
        "--playback-rate",
        type=float,
        default=1.0,
        help="Playback rate used with --realtime-file (1.0 = real time).",
    )
    parser.add_argument("--show", action="store_true", help="Show debug overlay window.")
    parser.add_argument("--analyze-only", action="store_true", help="Only log timestamps/laps, do not call API.")
    parser.add_argument("--start-confirm-hits", type=int, default=None, help="Override SC start confirm hits.")
    parser.add_argument("--start-confirm-window", type=int, default=None, help="Override SC start confirm window.")
    parser.add_argument("--ending-confirm-hits", type=int, default=None, help="Override SC ending confirm hits.")
    parser.add_argument("--ending-confirm-window", type=int, default=None, help="Override SC ending confirm window.")
    return parser.parse_args()


def open_capture(source_arg: str):
    if source_arg.isdigit():
        return cv2.VideoCapture(int(source_arg))
    return cv2.VideoCapture(source_arg)


def clip_time_s(cap: cv2.VideoCapture) -> float:
    ms = cap.get(cv2.CAP_PROP_POS_MSEC)
    if ms <= 0:
        return 0.0
    return ms / 1000.0


def scale_confirmation(confirm_hits: int, confirm_window: int, detect_fps: float) -> tuple[int, int]:
    # Treat thresholds as frame counts (no fps scaling).
    hits = max(1, int(confirm_hits))
    window = max(1, int(confirm_window))
    return min(hits, window), window


def load_event_pipeline() -> Callable[[dict[str, Any]], dict[str, Any]] | None:
    apps_root = Path(__file__).resolve().parents[1]
    if str(apps_root) not in sys.path:
        sys.path.insert(0, str(apps_root))

    try:
        pipeline = importlib.import_module("event_create.pipeline")
        bootstrap_env = getattr(pipeline, "_bootstrap_env", None)
        if callable(bootstrap_env):
            bootstrap_env()
        build_event_payload = getattr(pipeline, "build_event_payload", None)
        if callable(build_event_payload):
            return build_event_payload
        print("[llm] pipeline_unavailable reason=missing_build_event_payload")
    except Exception as exc:
        print(f"[llm] pipeline_unavailable error={exc}")
    return None


def build_custom_question(
    build_event_payload: Callable[[dict[str, Any]], dict[str, Any]] | None,
    *,
    event_id: str,
    session_id: str,
    trigger_type: str,
    lap_start: int | None,
    confidence: float,
    market_line_laps: float,
    market_duration_ms: int,
    clip_time_s: float,
) -> tuple[str | None, str | None, str | None]:
    if build_event_payload is None:
        return None, None, None

    payload = {
        "event_id": event_id,
        "event_type": "f1_safety_car_laps",
        "session_id": session_id,
        "trigger_type": trigger_type,
        "lap_start": lap_start,
        "market_line_laps": market_line_laps,
        "duration_seconds": max(30, int(round(market_duration_ms / 1000))),
        "source_confidence": confidence,
        "source_event_id": event_id,
        "context": f"Vision trigger at t={clip_time_s:.2f}s from safety-car broadcast banner OCR.",
    }

    try:
        llm_payload = build_event_payload(payload)
    except Exception as exc:
        print(f"[llm] pipeline_error error={exc}")
        return None, None, None

    if not isinstance(llm_payload, dict):
        return None, None, None

    question = llm_payload.get("question")
    context = llm_payload.get("context")
    ai_summary = llm_payload.get("ai_summary")

    question_text = question.strip() if isinstance(question, str) and question.strip() else None
    context_text = context.strip() if isinstance(context, str) and context.strip() else None
    summary_text = ai_summary.strip() if isinstance(ai_summary, str) and ai_summary.strip() else None
    if question_text:
        if isinstance(lap_start, int) and lap_start > 0:
            prefix = f"Safety Car spotted on Lap {lap_start}."
        else:
            prefix = "Safety Car spotted during the race."
        return f"{prefix} {question_text}", context_text, summary_text
    return None, context_text, summary_text


def main() -> None:
    args = parse_args()
    cap = open_capture(str(args.source))
    if not cap.isOpened():
        raise RuntimeError(f"Failed to open video source: {args.source}")
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if source_fps <= 0:
        source_fps = 30.0
    frame_index = 0

    cfg = SafetyCarLapsConfig()
    ocr = OcrReader()
    detector = YellowFlagDetector(
        ocr=ocr,
        roi_top_ratio=cfg.roi_top_ratio,
        roi_bottom_ratio=cfg.roi_bottom_ratio,
        roi_right_ratio=cfg.roi_right_ratio,
    )
    build_event_payload = load_event_pipeline()
    client = MarketClient(args.api_base_url)

    interval_s = 1.0 / max(args.fps, 0.5)
    last_tick = 0.0
    sample_step = None
    source_path = str(args.source)
    source_is_file = Path(source_path).exists() and not source_path.isdigit()
    if args.sample_fps and args.sample_fps > 0 and source_is_file:
        sample_step = max(1, int(round(source_fps / args.sample_fps)))
    eval_fps = args.sample_fps if sample_step is not None else args.fps
    playback_rate = max(0.1, float(args.playback_rate))
    realtime_file = bool(args.realtime_file and source_is_file)
    file_wall_start_s = time.time()
    file_start_clip_s: float | None = None

    start_hits_cfg = args.start_confirm_hits if args.start_confirm_hits is not None else cfg.start_confirm_hits
    start_window_cfg = args.start_confirm_window if args.start_confirm_window is not None else cfg.start_confirm_window
    ending_hits_cfg = args.ending_confirm_hits if args.ending_confirm_hits is not None else cfg.ending_confirm_hits
    ending_window_cfg = (
        args.ending_confirm_window if args.ending_confirm_window is not None else cfg.ending_confirm_window
    )

    start_hits, start_window = scale_confirmation(start_hits_cfg, start_window_cfg, eval_fps)
    ending_hits, ending_window = scale_confirmation(ending_hits_cfg, ending_window_cfg, eval_fps)
    start_fsm = TriggerFSM(
        confirm_hits=start_hits,
        confirm_window=start_window,
        cooldown_seconds=cfg.cooldown_seconds,
    )
    ending_fsm = TriggerFSM(
        confirm_hits=ending_hits,
        confirm_window=ending_window,
        cooldown_seconds=1,
    )
    paused = False
    active_market: ActiveSafetyCarMarket | None = None
    sc_start_logged = False
    sc_start_frame_index: int | None = None
    sc_ending_logged = False
    last_text = ""
    last_lap: int | None = None
    sc_start_lap: int | None = None
    sc_ending_lap: int | None = None
    sc_ending_time_s: float | None = None
    last_status = "idle"
    last_start_text = ""
    next_progress_log_s = 20.0
    start_wall_s = time.time()

    print(
        f"[agent] source={args.source} mode=sc_laps ocr={ocr.mode} fps={args.fps} analyze_only={args.analyze_only} "
        f"roi=top:{cfg.roi_top_ratio:.2f}-{cfg.roi_bottom_ratio:.2f},left:0-{cfg.roi_right_ratio:.2f}"
    )
    if sample_step is not None:
        print(f"[agent] sampling=enabled sample_fps={args.sample_fps} step={sample_step}")
    if realtime_file:
        print(f"[agent] realtime_file=enabled playback_rate={playback_rate:.2f}x")
    print(f"[agent] fsm start={start_hits}/{start_window} ending={ending_hits}/{ending_window} eval_fps={eval_fps}")
    print(f"[agent] llm_pipeline={'enabled' if build_event_payload else 'disabled'}")
    print("[agent] controls: s=force SC start, e=force SC ending, p=pause, q=quit")

    while True:
        ok, frame = cap.read()
        if not ok:
            print("[agent] stream ended")
            break
        frame_index += 1

        clip_t = frame_index / source_fps
        if realtime_file:
            if file_start_clip_s is None:
                file_start_clip_s = clip_t
            target_elapsed_s = (clip_t - file_start_clip_s) / playback_rate
            wall_elapsed_s = time.time() - file_wall_start_s
            sleep_s = target_elapsed_s - wall_elapsed_s
            if sleep_s > 0:
                time.sleep(min(sleep_s, 0.25))

        now_s = time.time()
        if sample_step is not None and frame_index % sample_step != 0:
            if args.show:
                cv2.imshow("vision-agent", frame)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break
            continue

        if sample_step is None and now_s - last_tick < interval_s:
            if args.show:
                cv2.imshow("vision-agent", frame)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break
            continue

        last_tick = now_s
        current_ms = now_ms()
        t_s = clip_t
        if t_s >= next_progress_log_s:
            wall_elapsed_s = time.time() - start_wall_s
            speed_x = (t_s / wall_elapsed_s) if wall_elapsed_s > 0 else 0.0
            print(
                f"[progress] clip_t={t_s:.2f}s wall_t={wall_elapsed_s:.2f}s speed={speed_x:.2f}x "
                f"last_lap={last_lap} sc_start={sc_start_logged} sc_ending={sc_ending_logged}"
            )
            next_progress_log_s += 20.0

        key = cv2.waitKey(1) & 0xFF if args.show else -1
        if key == ord("q"):
            break
        if key == ord("p"):
            paused = not paused
            print(f"[agent] paused={paused}")
        if paused:
            continue

        if key == ord("s"):
            sc_hit, sc_conf, sc_text = True, 1.0, "manual_sc_start"
        else:
            sc_hit, sc_conf, sc_text = detector.detect_safety_car(frame)

        if key == ord("e"):
            end_hit, end_conf, end_text = True, 1.0, "manual_sc_ending"
        else:
            end_hit, end_conf, end_text = detector.detect_safety_car_ending(frame)

        lap = detector.parse_lap(sc_text)
        if lap is None:
            lap = detector.parse_lap(end_text)

        last_text = sc_text if sc_hit else end_text
        if isinstance(lap, int):
            last_lap = lap

        # If lap was missing at SC start, capture the next available lap mention.
        if sc_start_logged and sc_start_lap is None and isinstance(lap, int):
            sc_start_lap = lap
            if active_market is not None:
                active_market.lap_start = lap
            print(f"[lap_start_captured] t={t_s:.2f}s lap={lap}")

        # If SC ENDING is already seen and lap missing there, capture the next available lap.
        if sc_ending_logged and sc_ending_lap is None and isinstance(lap, int):
            sc_ending_lap = lap
            print(f"[lap_end_captured] t={t_s:.2f}s lap={lap}")

        start_signal = sc_hit and not end_hit and sc_conf >= cfg.confidence_threshold
        ending_signal = end_hit and end_conf >= cfg.confidence_threshold
        start_confirmed = start_fsm.update(start_signal, now_s)
        ending_confirmed = ending_fsm.update(ending_signal, now_s)

        if start_confirmed and not sc_start_logged:
            sc_start_logged = True
            sc_start_frame_index = frame_index
            last_start_text = sc_text
            sc_start_lap = lap
            print(f"[sc_start] t={t_s:.2f}s lap={lap} text={sc_text[:120]!r}")

            if not args.analyze_only:
                event_id = f"evt_{uuid4().hex[:8]}"
                custom_question, llm_context, ai_summary = build_custom_question(
                    build_event_payload,
                    event_id=event_id,
                    session_id=args.session_id,
                    trigger_type="SAFETY_CAR_START",
                    lap_start=lap if isinstance(lap, int) else None,
                    confidence=sc_conf,
                    market_line_laps=3.5,
                    market_duration_ms=cfg.market_duration_ms,
                    clip_time_s=t_s,
                )
                starter_context = {
                    "ocr_text": sc_text,
                    "lap_start": lap,
                    "market_line_laps": 3.5,
                    "detector": "safety_car_banner_ocr",
                }
                if custom_question:
                    starter_context["custom_question"] = custom_question
                if llm_context:
                    starter_context["llm_context"] = llm_context
                if ai_summary:
                    starter_context["ai_summary"] = ai_summary
                if custom_question:
                    print(f"[llm] custom_question={custom_question!r}")
                starter = StarterSignal(
                    event_id=event_id,
                    trigger_type="SAFETY_CAR_START",
                    session_id=args.session_id,
                    timestamp_ms=current_ms,
                    lap=lap,
                    confidence=sc_conf,
                    cooldown_key=f"{args.session_id}:SAFETY_CAR_START",
                    market_duration_ms=cfg.market_duration_ms,
                    context=starter_context,
                )
                try:
                    response = client.post_starter(starter)
                    market = response.get("market")
                    if market:
                        active_market = ActiveSafetyCarMarket(
                            market_id=market["market_id"],
                            event_id=event_id,
                            lap_start=lap,
                            t_start_s=t_s,
                        )
                        last_status = f"opened:{active_market.market_id}"
                        print(f"[starter] opened market={active_market.market_id}")
                except Exception as exc:
                    last_status = "starter_error"
                    print(f"[starter] error={exc}")

        if (
            ending_confirmed
            and ending_signal
            and sc_start_logged
            and not sc_ending_logged
            and sc_start_frame_index is not None
            and frame_index > sc_start_frame_index
        ):
            sc_ending_logged = True
            sc_ending_time_s = t_s
            sc_ending_lap = lap if isinstance(lap, int) else last_lap
            print(f"[sc_ending] t={t_s:.2f}s lap={lap} text={end_text[:120]!r}")

        # Finalize immediately when SC ENDING appears.
        if sc_ending_logged and sc_ending_time_s is not None:
            lap_start = active_market.lap_start if active_market else sc_start_lap
            lap_end = sc_ending_lap if isinstance(sc_ending_lap, int) else last_lap
            laps_delta = (lap_end - lap_start) if isinstance(lap_start, int) and isinstance(lap_end, int) else None
            print(
                f"[sc_result] t_end={t_s:.2f}s lap_start={lap_start} lap_end={lap_end} delta_laps={laps_delta}"
            )
            if not args.analyze_only and active_market is not None:
                outcome = "YES" if isinstance(laps_delta, int) and laps_delta >= 4 else "NO"
                resolution = ResolutionSignal(
                    event_id=f"res_{uuid4().hex[:8]}",
                    market_id=active_market.market_id,
                    outcome=outcome,
                    confidence=end_conf,
                    resolved_at_ms=current_ms,
                    reason="safety_car_ending_detected",
                    context={
                        "lap_start": lap_start,
                        "lap_end": lap_end,
                        "delta_laps": laps_delta,
                        "over_3_5_laps": bool(isinstance(laps_delta, int) and laps_delta >= 4),
                        "ocr_text": end_text,
                    },
                )
                try:
                    settled = client.post_resolution(resolution)
                    print(
                        f"[closer] market={active_market.market_id} outcome={outcome} "
                        f"status={(settled.get('market') or {}).get('status')} "
                        f"lap_start={lap_start} lap_end={lap_end} delta_laps={laps_delta}"
                    )
                except Exception as exc:
                    print(f"[closer] error={exc}")
            break

        if args.show:
            overlay = frame.copy()
            cv2.putText(overlay, f"OCR: {ocr.mode}", (16, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 220, 220), 2)
            cv2.putText(overlay, f"STATUS: {last_status}", (16, 54), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 220, 220), 2)
            cv2.putText(overlay, f"LAP: {last_lap}", (16, 82), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(overlay, f"TEXT: {last_text[:80]}", (16, 110), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.rectangle(
                overlay,
                (0, 0),
                (overlay.shape[1], int(overlay.shape[0] * cfg.roi_bottom_ratio)),
                (0, 255, 255),
                2,
            )
            cv2.imshow("vision-agent", overlay)

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
