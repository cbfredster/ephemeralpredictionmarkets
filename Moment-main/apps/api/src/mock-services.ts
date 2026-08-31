import { randomUUID } from "node:crypto";

import type { Selection, Sport } from "./types";

export type BetStarterEvent = {
  event_id: string;
  sport: Sport;
  event_type: string;
  session_id?: string;
  context?: Record<string, unknown>;
  detected_at_ms: number;
};

export type BetCloseTrigger = {
  trigger_id: string;
  market_id: string;
  reason: string;
  expected_outcome?: Selection;
  triggered_at_ms: number;
};

type StarterHandler = (event: BetStarterEvent) => void;
type CloserHandler = (trigger: BetCloseTrigger) => void | Promise<void>;

export class MockBetStarterService {
  private readonly intervalMs: number;
  private readonly onDetected: StarterHandler;
  private timer?: NodeJS.Timeout;

  constructor(onDetected: StarterHandler, options?: { intervalMs?: number }) {
    this.onDetected = onDetected;
    this.intervalMs = Math.max(0, Number(options?.intervalMs ?? 0));

    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        this.trigger({
          sport: "F1",
          event_type: "overtake_in_x_laps",
          context: { laps: 2, driver_a: "Norris", driver_b: "Verstappen" },
        });
      }, this.intervalMs);
    }
  }

  trigger(input: {
    sport: Sport;
    event_type: string;
    session_id?: string;
    context?: Record<string, unknown>;
  }): BetStarterEvent {
    const event: BetStarterEvent = {
      event_id: `evt_${randomUUID().slice(0, 8)}`,
      sport: input.sport,
      event_type: input.event_type,
      session_id: input.session_id,
      context: input.context ?? {},
      detected_at_ms: Date.now(),
    };
    this.onDetected(event);
    return event;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export class MockBetCloserService {
  private readonly onTriggered: CloserHandler;

  constructor(onTriggered: CloserHandler) {
    this.onTriggered = onTriggered;
  }

  triggerClose(market_id: string, options?: { reason?: string; expected_outcome?: Selection }): BetCloseTrigger {
    const trigger: BetCloseTrigger = {
      trigger_id: `cls_${randomUUID().slice(0, 8)}`,
      market_id,
      reason: options?.reason ?? "manual_dev_trigger",
      expected_outcome: options?.expected_outcome,
      triggered_at_ms: Date.now(),
    };
    void this.onTriggered(trigger);
    return trigger;
  }

  stop(): void {
    // No background resources for closer service.
  }
}
