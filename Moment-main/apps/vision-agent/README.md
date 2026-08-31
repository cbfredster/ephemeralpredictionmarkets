# Vision Agent (MVP)

Live F1 flash-market sidecar focused on standardized world-feed graphics.

## MVP scope

- Trigger: `SAFETY_CAR_START` from OCR banner detection.
- Close: `SAFETY CAR ENDING` sends a direct close signal for the active market.
- Frame rate target: 4-8 FPS.
- Analyze-only mode logs timestamps and lap numbers without posting to API.

## API contract used by vision

- `POST /scanner/events` with `signal_type="create_bet"`:
  - Parsed by API into starter pipeline (`/starter/events` equivalent).
  - Opens a market when dedupe/cooldown allows.
- `POST /scanner/events` with `signal_type="close_bet"`:
  - Directly closes the target market (`engine.closeMarket`) without resolution pipeline.

## Install

```bash
cd apps/vision-agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python run_agent.py --source 0 --session-id demo_session --api-base-url http://127.0.0.1:4000 --fps 5 --show
python run_agent.py --source /path/to/clip.mov --session-id demo_session --fps 2 --analyze-only
```

`--source` can be webcam index (`0`), video file path, or RTSP URL.

## Controls

- `s`: force Safety Car start
- `e`: force Safety Car ending
- `p`: pause/resume detectors
- `q`: quit
