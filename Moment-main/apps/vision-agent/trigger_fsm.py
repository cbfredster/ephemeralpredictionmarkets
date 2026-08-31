from collections import deque


class TriggerFSM:
    def __init__(self, confirm_hits: int, confirm_window: int, cooldown_seconds: int) -> None:
        self.confirm_hits = confirm_hits
        self.confirm_window = confirm_window
        self.cooldown_seconds = cooldown_seconds
        self.history: deque[int] = deque(maxlen=confirm_window)
        self.last_fired_ts: float = 0.0

    def update(self, hit: bool, now_s: float) -> bool:
        self.history.append(1 if hit else 0)
        if len(self.history) < self.confirm_window:
            return False
        if sum(self.history) < self.confirm_hits:
            return False
        if now_s - self.last_fired_ts < self.cooldown_seconds:
            return False
        self.last_fired_ts = now_s
        return True

