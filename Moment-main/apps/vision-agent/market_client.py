import json
from typing import Any

import requests

from schemas import ResolutionSignal, StarterSignal


class MarketClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def _post_json(self, path: str, payload: dict[str, Any], label: str) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        print(
            f"[http:{label}:request] method=POST url={url} payload="
            f"{json.dumps(payload, ensure_ascii=True, separators=(',', ':'))}"
        )
        response = requests.post(url, json=payload, timeout=3)
        raw = response.text.strip()
        print(f"[http:{label}:response] status={response.status_code} body={raw}")
        response.raise_for_status()
        try:
            return response.json()
        except Exception:
            return {"raw": raw}

    def post_starter(self, signal: StarterSignal) -> dict[str, Any]:
        payload = signal.model_dump(exclude_none=True)
        return self._post_json("/starter/events", payload, "starter")

    def post_resolution(self, signal: ResolutionSignal) -> dict[str, Any]:
        payload = signal.model_dump(exclude_none=True)
        return self._post_json("/closer/resolutions", payload, "closer")
