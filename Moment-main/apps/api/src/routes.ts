import type { FastifyInstance } from "fastify";

import { EngineError, type MarketEngine } from "./engine";
import type { MockBetCloserService, MockBetStarterService } from "./mock-services";
import {
  betRequestSchema,
  closeMarketBodySchema,
  createUserBodySchema,
  loginBodySchema,
  marketIdParamSchema,
  quoteRequestSchema,
  scannerLifecycleEventBodySchema,
  scannerEventBodySchema,
  resolutionSignalBodySchema,
  settleMarketBodySchema,
  starterSignalBodySchema,
  starterEventBodySchema,
  userFundsBodySchema,
  userIdParamSchema,
  type ScannerLifecycleEventInput,
  type ScannerStockCreateEventInput,
  type Selection,
} from "./types";

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const parseTimestampMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};

const parseSelection = (value: unknown): Selection | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "YES" || normalized === "NO" || normalized === "HIGHER" || normalized === "LOWER") {
    return normalized;
  }
  if (normalized === "UP") return "HIGHER";
  if (normalized === "DOWN") return "LOWER";
  return undefined;
};

const resolveLifecycleDurationSeconds = (payload: Record<string, unknown>): number | undefined => {
  if (typeof payload.duration_seconds === "number" && Number.isFinite(payload.duration_seconds) && payload.duration_seconds > 0) {
    return Math.max(15, Math.round(payload.duration_seconds));
  }
  if (typeof payload.window_minutes === "number" && Number.isFinite(payload.window_minutes) && payload.window_minutes > 0) {
    return Math.max(15, Math.round(payload.window_minutes * 60));
  }
  return undefined;
};

const resolveStockCloseAtMs = (payload: {
  close_at_ms?: number;
  close_at?: string;
  close_time?: string;
  expires_at?: string;
}): number | undefined =>
  parseTimestampMs(payload.close_at_ms) ??
  parseTimestampMs(payload.close_at) ??
  parseTimestampMs(payload.close_time) ??
  parseTimestampMs(payload.expires_at);

const sanitizeStockMarketId = (raw: string): string => {
  const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.length ? normalized : `mkt_stocks_${Date.now()}`;
};

const toScannerStockCreateSignal = (
  lifecycleEvent: ScannerLifecycleEventInput,
  nowMs: number,
): ScannerStockCreateEventInput | undefined => {
  const payload = toRecord(lifecycleEvent.event_payload);
  const symbol =
    (typeof lifecycleEvent.ticker === "string" && lifecycleEvent.ticker.trim()) ||
    (typeof payload?.ticker === "string" && payload.ticker.trim()) ||
    (typeof payload?.symbol === "string" && payload.symbol.trim());
  if (!symbol) return undefined;

  const eventIdRaw = lifecycleEvent.event_id ?? payload?.event_id ?? `evt_${nowMs}`;
  const eventId = String(eventIdRaw).trim() || `evt_${nowMs}`;
  const marketIdRaw =
    (typeof lifecycleEvent.market_id === "string" && lifecycleEvent.market_id.trim()) ||
    (typeof payload?.market_id === "string" && payload.market_id.trim()) ||
    `mkt_stocks_${symbol}_${eventId}`;
  const marketId = sanitizeStockMarketId(marketIdRaw);
  const rawCloseAtMs =
    parseTimestampMs(lifecycleEvent.settle_at) ??
    parseTimestampMs(lifecycleEvent.expires_at) ??
    parseTimestampMs(payload?.close_at_ms) ??
    parseTimestampMs(payload?.close_at) ??
    parseTimestampMs(payload?.close_time) ??
    parseTimestampMs(payload?.expires_at);
  if (!rawCloseAtMs) return undefined;

  const contextRaw = lifecycleEvent.context;
  const lifecycleContext =
    typeof contextRaw === "string"
      ? ({ source_context_text: contextRaw } as Record<string, unknown>)
      : (toRecord(contextRaw) ?? {});
  const payloadContext = toRecord(payload?.context) ?? {};
  const mergedContext: Record<string, unknown> = {
    ...payloadContext,
    ...lifecycleContext,
    scanner_event: lifecycleEvent.event,
    scanner_event_type: lifecycleEvent.event_type ?? payload?.event_type,
    scanner_event_state: lifecycleEvent.event_state,
  };

  const durationSeconds = resolveLifecycleDurationSeconds(payload ?? {});
  const closeAtMs =
    rawCloseAtMs > nowMs ? rawCloseAtMs : nowMs + (durationSeconds !== undefined ? durationSeconds * 1000 : 60_000);
  if (rawCloseAtMs <= nowMs) {
    mergedContext.original_close_at_ms = rawCloseAtMs;
    mergedContext.close_time_shifted_to_now = true;
  }

  const timestampMs = parseTimestampMs(lifecycleEvent.event_at) ?? parseTimestampMs(payload?.event_at) ?? nowMs;
  const price =
    typeof lifecycleEvent.price === "number"
      ? lifecycleEvent.price
      : typeof payload?.price === "number"
        ? payload.price
        : typeof payload?.starting_price === "number"
          ? payload.starting_price
          : undefined;

  const question =
    (typeof lifecycleEvent.question === "string" && lifecycleEvent.question.trim()) ||
    (typeof payload?.question === "string" && payload.question.trim()) ||
    undefined;

  const settlementOutcome = parseSelection(payload?.settlement_outcome) ?? parseSelection(payload?.outcome);

  return {
    event_id: eventId,
    signal_type: "create_bet",
    sport: "Stocks",
    session_id:
      (typeof payload?.session_id === "string" && payload.session_id.trim()) ||
      `stocks-session-${new Date(nowMs).toISOString().slice(0, 10)}`,
    timestamp_ms: timestampMs,
    market_id: marketId,
    market_key:
      (typeof payload?.market_key === "string" && payload.market_key.trim()) ||
      (typeof payload?.event_type === "string" && payload.event_type.trim()) ||
      `scanner_${symbol.toUpperCase()}`,
    symbol: symbol.toUpperCase(),
    close_at_ms: closeAtMs,
    confidence:
      typeof payload?.source_confidence === "number"
        ? payload.source_confidence
        : typeof payload?.confidence === "number"
          ? payload.confidence
          : 1,
    cooldown_key:
      (typeof payload?.cooldown_key === "string" && payload.cooldown_key.trim()) ||
      `stocks:${symbol.toUpperCase()}:${marketId}`,
    window_minutes:
      typeof payload?.window_minutes === "number"
        ? payload.window_minutes
        : typeof payload?.duration_seconds === "number"
          ? Math.max(1, Math.round(payload.duration_seconds / 60))
          : undefined,
    question,
    settlement_outcome:
      settlementOutcome === "HIGHER" || settlementOutcome === "LOWER" ? settlementOutcome : undefined,
    price,
    price_at:
      (typeof lifecycleEvent.price_at === "string" && lifecycleEvent.price_at.trim()) ||
      (typeof payload?.price_at === "string" && payload.price_at.trim()) ||
      timestampMs,
    context: mergedContext,
  };
};

const deriveStockOutcomeFromLifecycle = (
  lifecycleEvent: ScannerLifecycleEventInput,
  fallbackPayload?: Record<string, unknown>,
): Selection | undefined => {
  const payload = fallbackPayload ?? toRecord(lifecycleEvent.event_payload) ?? {};
  const explicit =
    parseSelection(payload.settlement_outcome) ??
    parseSelection(payload.outcome) ??
    parseSelection(payload.expected_outcome) ??
    parseSelection(lifecycleEvent.context && toRecord(lifecycleEvent.context)?.outcome);
  if (explicit === "HIGHER" || explicit === "LOWER") return explicit;

  const directionRaw =
    (typeof payload.target_direction === "string" && payload.target_direction) ||
    (typeof payload.direction === "string" && payload.direction) ||
    undefined;
  const direction = typeof directionRaw === "string" ? directionRaw.trim().toUpperCase() : "";
  if (typeof lifecycleEvent.target_hit === "boolean") {
    if (direction === "UP") return lifecycleEvent.target_hit ? "HIGHER" : "LOWER";
    if (direction === "DOWN") return lifecycleEvent.target_hit ? "LOWER" : "HIGHER";
  }
  if (typeof payload.target_hit === "boolean") {
    if (direction === "UP") return payload.target_hit ? "HIGHER" : "LOWER";
    if (direction === "DOWN") return payload.target_hit ? "LOWER" : "HIGHER";
  }

  const move =
    (typeof lifecycleEvent.final_move_from_start_pct === "number" && lifecycleEvent.final_move_from_start_pct) ||
    (typeof payload.final_move_from_start_pct === "number" && payload.final_move_from_start_pct);
  if (typeof move === "number" && Number.isFinite(move)) {
    return move >= 0 ? "HIGHER" : "LOWER";
  }

  return undefined;
};

export const registerRoutes = (
  fastify: FastifyInstance,
  engine: MarketEngine,
  starter: MockBetStarterService,
  closer: MockBetCloserService,
): void => {
  fastify.get("/health", async () => ({
    status: "ok",
    service: "moment-api",
    timestamp_ms: Date.now(),
    uptime_s: process.uptime(),
  }));

  fastify.get("/markets/live", async () => engine.getLiveMarkets());

  fastify.get("/markets/:marketId", async (request, reply) => {
    const { marketId } = marketIdParamSchema.parse(request.params);
    const market = engine.getMarket(marketId);

    if (!market) {
      return reply.code(404).send({ message: "Market not found" });
    }

    return market;
  });

  fastify.post("/quotes", async (request, reply) => {
    const body = quoteRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    try {
      return engine.quoteBet(body.data);
    } catch (error) {
      if (error instanceof EngineError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  const handlePlacePick = async (request: any, reply: any) => {
    const body = betRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    const result = engine.placeBet(body.data);

    if (result.rejectedBet) {
      return reply.code(400).send(result.rejectedBet);
    }

    if (result.error) {
      return reply.code(400).send({ message: result.error });
    }

    return result.bet;
  };

  fastify.post("/picks", handlePlacePick);

  fastify.get("/picks/:userId", async (request) => {
    const { userId } = userIdParamSchema.parse(request.params);
    return engine.getBetsForUser(userId);
  });

  fastify.get("/users/:userId/wallet", async (request) => {
    const { userId } = userIdParamSchema.parse(request.params);
    return engine.getWallet(userId);
  });

  fastify.get("/users/:userId", async (request) => {
    const { userId } = userIdParamSchema.parse(request.params);
    return engine.getUser(userId);
  });

  fastify.post("/auth/register", async (request, reply) => {
    const body = createUserBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    try {
      return engine.registerUser(body.data.username, body.data.pin);
    } catch (error) {
      if (error instanceof EngineError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  fastify.post("/auth/login", async (request, reply) => {
    const body = loginBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    try {
      return engine.loginUser(body.data.username, body.data.pin);
    } catch (error) {
      if (error instanceof EngineError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  fastify.post("/users/:userId/funds/add", async (request, reply) => {
    const { userId } = userIdParamSchema.parse(request.params);
    const body = userFundsBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    try {
      const wallet = engine.addFunds(userId, body.data.amount);
      return { wallet };
    } catch (error) {
      if (error instanceof EngineError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  fastify.post("/users/:userId/funds/withdraw", async (request, reply) => {
    const { userId } = userIdParamSchema.parse(request.params);
    const body = userFundsBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    try {
      const wallet = engine.withdrawFunds(userId, body.data.amount);
      return { wallet };
    } catch (error) {
      if (error instanceof EngineError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  fastify.get("/events/stream-status", async () => {
    return engine.getStreamStatus();
  });

  fastify.post("/dev/simulate/starter-event", async (request, reply) => {
    const body = starterEventBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    const sport = body.data.sport ?? "F1";
    const fallbackEventType = sport === "Stocks" ? "stock_up_down_window" : "overtake_in_x_laps";

    // Fire through the starter service so the full bus pipeline runs
    const event = starter.trigger({
      sport,
      event_type: body.data.event_type ?? fallbackEventType,
      session_id: body.data.session_id,
      context: body.data.context,
    });

    return { ok: true, event };
  });

  fastify.post("/dev/simulate/close-market", async (request, reply) => {
    const body = closeMarketBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    const market = engine.getMarket(body.data.market_id);
    if (!market) {
      return reply.code(404).send({ message: "Market not found" });
    }

    // Fire through the closer bus so auto-settle kicks in after 2s
    const trigger = closer.triggerClose(body.data.market_id, { reason: body.data.reason ?? "manual_dev_trigger" });
    return { ok: true, trigger };
  });

  fastify.post("/dev/simulate/settle-market", async (request, reply) => {
    const body = settleMarketBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    const market = engine.getMarket(body.data.market_id);
    if (!market) {
      return reply.code(404).send({ message: "Market not found" });
    }

    const fallback: Selection = market.market_type === "binary_higher_lower" ? "HIGHER" : "YES";
    const settled = await engine.settleMarket(market.market_id, body.data.outcome ?? fallback);

    return { ok: true, market: settled };
  });

  fastify.post("/dev/simulate/reset", async () => {
    engine.reset();
    return { ok: true };
  });

  fastify.post("/scanner/events", async (request, reply) => {
    const rawBody = request.body ?? {};
    const direct = scannerEventBodySchema.safeParse(rawBody);

    if (direct.success) {
      if (direct.data.signal_type === "create_bet" && direct.data.sport === "Stocks") {
        const closeAtMs = resolveStockCloseAtMs(direct.data);
        if (!closeAtMs) {
          return reply
            .code(400)
            .send({ message: "Stocks create_bet requires close_at_ms (or close_at/close_time/expires_at)." });
        }
        const result = engine.ingestStockCreateSignal({ ...direct.data, close_at_ms: closeAtMs });
        return {
          ok: true,
          mode: "stocks_create",
          deduped: result.deduped,
          reason: result.reason,
          market: result.market,
          close_at_ms: closeAtMs,
        };
      }

      if (direct.data.signal_type === "create_bet") {
        const result = engine.ingestStarterSignal({
          event_id: direct.data.event_id,
          sport: direct.data.sport,
          trigger_type: direct.data.trigger_type,
          session_id: direct.data.session_id,
          timestamp_ms: direct.data.timestamp_ms,
          lap: direct.data.lap,
          driver: direct.data.driver,
          rival_driver: direct.data.rival_driver,
          confidence: direct.data.confidence,
          cooldown_key: direct.data.cooldown_key,
          market_duration_ms: direct.data.market_duration_ms,
          context: direct.data.context,
        });

        return {
          ok: true,
          mode: "starter_pipeline",
          deduped: result.deduped,
          reason: result.reason,
          market: result.market,
        };
      }

      if (direct.data.signal_type === "market_update") {
        const market = engine.ingestStockMarketUpdate(direct.data);
        if (!market) {
          return reply.code(404).send({ message: "Market not found for stock update" });
        }
        return {
          ok: true,
          mode: "stocks_update",
          market,
          updated_at_ms: Date.now(),
        };
      }

      const existingMarket = engine.getMarket(direct.data.market_id);
      if (!existingMarket) {
        return reply.code(404).send({ message: "Market not found" });
      }

      if (existingMarket.sport !== "Stocks") {
        const market = engine.closeMarket(direct.data.market_id, direct.data.reason ?? "scanner_close_signal");
        return {
          ok: true,
          mode: "direct_close",
          market,
          closed_by_event_id: direct.data.event_id,
          closed_at_ms: direct.data.timestamp_ms ?? Date.now(),
        };
      }

      const market = await engine.closeAndSettleMarketImmediately(direct.data.market_id, direct.data.settlement_outcome, {
        reason: direct.data.reason ?? "scanner_close_signal",
      });
      return {
        ok: true,
        mode: "direct_close_and_settle",
        market,
        closed_by_event_id: direct.data.event_id,
        closed_at_ms: direct.data.timestamp_ms ?? Date.now(),
      };
    }

    const lifecycle = scannerLifecycleEventBodySchema.safeParse(rawBody);
    if (!lifecycle.success) {
      return reply.code(400).send({ message: direct.error.message });
    }

    const lifecyclePayload = lifecycle.data;
    const nowMs = Date.now();
    const payloadRecord = toRecord(lifecyclePayload.event_payload) ?? {};
    const eventIdRaw = lifecyclePayload.event_id ?? payloadRecord.event_id ?? `evt_${nowMs}`;
    const eventId = String(eventIdRaw).trim() || `evt_${nowMs}`;
    const symbolRaw =
      (typeof lifecyclePayload.ticker === "string" ? lifecyclePayload.ticker.trim() : "") ||
      (typeof payloadRecord.ticker === "string" ? payloadRecord.ticker.trim() : "") ||
      (typeof payloadRecord.symbol === "string" ? payloadRecord.symbol.trim() : "") ||
      undefined;
    const marketIdRaw =
      (typeof lifecyclePayload.market_id === "string" && lifecyclePayload.market_id.trim()) ||
      (typeof payloadRecord.market_id === "string" && payloadRecord.market_id.trim()) ||
      (symbolRaw ? `mkt_stocks_${symbolRaw}_${eventId}` : undefined);
    const marketId = marketIdRaw ? sanitizeStockMarketId(marketIdRaw) : undefined;

    if (lifecyclePayload.event === "event_created") {
      const createSignal = toScannerStockCreateSignal(lifecyclePayload, nowMs);
      if (!createSignal || typeof createSignal.close_at_ms !== "number") {
        return reply
          .code(400)
          .send({ message: "event_created must include ticker/symbol and close time (expires_at/settle_at/close_at)." });
      }
      const result = engine.ingestStockCreateSignal({ ...createSignal, close_at_ms: createSignal.close_at_ms });
      return {
        ok: true,
        mode: "stocks_lifecycle_create",
        deduped: result.deduped,
        reason: result.reason,
        market: result.market,
        close_at_ms: createSignal.close_at_ms,
      };
    }

    if (!marketId) {
      return reply.code(400).send({ message: "Could not derive market_id for lifecycle event." });
    }

    if (lifecyclePayload.event === "event_active") {
      const rawCloseAtMs =
        parseTimestampMs(lifecyclePayload.settle_at) ??
        parseTimestampMs(lifecyclePayload.expires_at) ??
        parseTimestampMs(payloadRecord.close_at_ms) ??
        parseTimestampMs(payloadRecord.close_at) ??
        parseTimestampMs(payloadRecord.close_time) ??
        parseTimestampMs(payloadRecord.expires_at);
      const closeAtMs = rawCloseAtMs && rawCloseAtMs > nowMs ? rawCloseAtMs : undefined;
      const timestampMs = parseTimestampMs(lifecyclePayload.event_at) ?? parseTimestampMs(payloadRecord.event_at) ?? nowMs;
      const price =
        typeof lifecyclePayload.price === "number"
          ? lifecyclePayload.price
          : typeof payloadRecord.price === "number"
            ? payloadRecord.price
            : undefined;
      const contextRaw = lifecyclePayload.context;
      const lifecycleContext =
        typeof contextRaw === "string"
          ? ({ source_context_text: contextRaw } as Record<string, unknown>)
          : (toRecord(contextRaw) ?? {});
      const market = engine.ingestStockMarketUpdate({
        signal_type: "market_update",
        sport: "Stocks",
        market_id: marketId,
        timestamp_ms: timestampMs,
        symbol: symbolRaw?.toUpperCase(),
        price,
        close_at_ms: closeAtMs,
        context: {
          ...payloadRecord,
          ...lifecycleContext,
          scanner_event: lifecyclePayload.event,
          scanner_event_state: lifecyclePayload.event_state,
          scanner_event_type: lifecyclePayload.event_type,
        },
      });
      if (!market) {
        return reply.code(404).send({ message: "Market not found for lifecycle active update" });
      }
      return {
        ok: true,
        mode: "stocks_lifecycle_active",
        market,
        market_id: marketId,
      };
    }

    const outcome = deriveStockOutcomeFromLifecycle(lifecyclePayload, payloadRecord);
    const market = await engine.closeAndSettleMarketImmediately(marketId, outcome, {
      reason: lifecyclePayload.close_reason ?? "scanner_event_closed",
    });
    if (!market) {
      return reply.code(404).send({ message: "Market not found for lifecycle close event" });
    }

    return {
      ok: true,
      mode: "stocks_lifecycle_close_and_settle",
      market,
      market_id: marketId,
      settlement_outcome: market.settlement_outcome,
    };
  });

  fastify.post("/starter/events", async (request, reply) => {
    const body = starterSignalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    const result = engine.ingestStarterSignal(body.data);
    return {
      ok: true,
      deduped: result.deduped,
      reason: result.reason,
      market: result.market,
    };
  });

  fastify.post("/closer/resolutions", async (request, reply) => {
    const body = resolutionSignalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ message: body.error.message });
    }

    const market = await engine.ingestResolutionSignal(body.data);
    if (!market) {
      return reply.code(404).send({ message: "Market not found" });
    }

    return { ok: true, market };
  });
};
