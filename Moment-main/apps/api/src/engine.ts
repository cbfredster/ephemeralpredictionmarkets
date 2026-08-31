import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  AmmState,
  Bet,
  BetRequest,
  Market,
  MarketType,
  PublicUserAccount,
  PublishEventName,
  ResolutionSignalInput,
  ScannerStockCreateEventInput,
  ScannerStockUpdateEventInput,
  Selection,
  Sport,
  StarterInput,
  StarterSignalInput,
  StreamStatus,
  UserAccount,
  TriggerType,
  Wallet,
} from "./types";

const readPositiveNumber = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

// Keep this low enough that small stakes (e.g. €1/€5/€10) visibly move prices.
const DEFAULT_VIRTUAL_LIQUIDITY = readPositiveNumber(process.env.AMM_VIRTUAL_LIQUIDITY, 120);
const DEFAULT_FEE_BPS = 120;
const DEFAULT_INITIAL_PROBABILITY = 0.5;
const DEFAULT_STARTING_BALANCE = 100;
const DEFAULT_DEMO_PIN = "1234";
const ACCOUNTS_FILE = resolve(process.cwd(), "data", "accounts.json");
const MARKETS_FILE = resolve(process.cwd(), "data", "markets.json");
const MIN_MARKET_DURATION_MS = 30_000;
const MAX_MARKET_DURATION_MS = 900_000;

const triggerToEventType = (triggerType: TriggerType): string => {
  if (triggerType === "YELLOW_FLAG_START") return "yellow_flag_start";
  if (triggerType === "PIT_STATE_CHANGE") return "pit_state_change";
  if (triggerType === "SAFETY_CAR_START") return "safety_car_start";
  return "battle_window_start";
};

const displayName = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) return "the driver";
  return value.trim();
};

const F1_DRIVERS = [
  ["Norris", "Verstappen"],
  ["Leclerc", "Piastri"],
  ["Hamilton", "Russell"],
  ["Sainz", "Alonso"],
] as const;

const VOLATILE_STOCKS = ["TSLA", "NVDA", "COIN", "MSTR", "PLTR", "SMCI"] as const;

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));
const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const normalizeSelection = (selection: Selection): "YES" | "NO" =>
  selection === "YES" || selection === "HIGHER" ? "YES" : "NO";

const isF1Market = (market: Pick<Market, "sport">): boolean => market.sport === "F1";

const validSelection = (marketType: MarketType, selection: Selection): boolean => {
  if (marketType === "binary_yes_no") return selection === "YES" || selection === "NO";
  return selection === "HIGHER" || selection === "LOWER";
};

const getImpliedProbabilities = (amm: AmmState): { yes: number; no: number } => {
  const total = amm.yes_pool + amm.no_pool;
  if (total <= 0) return { yes: 0.5, no: 0.5 };
  return { yes: amm.yes_pool / total, no: amm.no_pool / total };
};

const createAmmState = (initialProbabilityYes: number, virtualLiquidity: number, feeBps: number): AmmState => {
  const p = clamp(initialProbabilityYes, 0.01, 0.99);
  return {
    yes_pool: virtualLiquidity * p,
    no_pool: virtualLiquidity * (1 - p),
    fee_bps: feeBps,
    virtual_liquidity: virtualLiquidity,
    total_fees_collected: 0,
    total_volume: 0,
    trade_count: 0,
  };
};

const getQuote = (amm: AmmState, selection: Selection, stake: number) => {
  const side = normalizeSelection(selection);
  const before = getImpliedProbabilities(amm);
  const priceBefore = side === "YES" ? before.yes : before.no;
  const fee = stake * (amm.fee_bps / 10_000);
  const effectiveStake = stake - fee;

  const nextAmm: AmmState = {
    ...amm,
    total_fees_collected: amm.total_fees_collected + fee,
    total_volume: amm.total_volume + stake,
    trade_count: amm.trade_count + 1,
  };

  if (side === "YES") nextAmm.yes_pool += effectiveStake;
  else nextAmm.no_pool += effectiveStake;

  const after = getImpliedProbabilities(nextAmm);

  return {
    fee,
    effective_stake: effectiveStake,
    estimated_price: priceBefore,
    estimated_price_after: side === "YES" ? after.yes : after.no,
    potential_payout: effectiveStake / Math.max(priceBefore, 0.001),
    implied_probabilities_before: before,
    implied_probabilities_after: after,
    nextAmm,
  };
};

type PersistedAccountsState = {
  users: UserAccount[];
  wallets: Wallet[];
  picks: Bet[];
};
type PersistedMarketsState = {
  markets: Market[];
};

export class EngineError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export interface PlaceBetResult {
  bet?: Bet;
  rejectedBet?: Bet;
  error?: string;
}

interface SettledImmediatelyOptions {
  reason?: string;
}

interface SettleMarketOptions {
  skipOracleCheck?: boolean;
  skipDelay?: boolean;
}

interface ScannerStockCreateInputResolved extends ScannerStockCreateEventInput {
  close_at_ms: number;
}

interface MarketEngineOptions {
  maxOpenDurationMs?: number;
  safetySweepIntervalMs?: number;
  triggerCooldownMs?: number;
  enableSafetyTimeouts?: boolean;
}

interface MarketEngineDeps {
  publish: (eventName: PublishEventName, payload: unknown) => void;
  options?: MarketEngineOptions;
}

export class MarketEngine {
  private readonly publish: (eventName: PublishEventName, payload: unknown) => void;
  private readonly maxOpenDurationMs: number;
  private readonly safetySweepIntervalMs: number;
  private readonly triggerCooldownMs: number;
  private readonly enableSafetyTimeouts: boolean;

  private readonly markets = new Map<string, Market>();
  private readonly bets = new Map<string, Bet>();
  private readonly betsByUser = new Map<string, string[]>();
  private readonly wallets = new Map<string, Wallet>();
  private readonly users = new Map<string, UserAccount>();
  private readonly triggerCooldowns = new Map<string, number>();

  private safetyHandle?: NodeJS.Timeout;
  private readonly stockCloseTimers = new Map<string, NodeJS.Timeout>();

  private readonly streamStatus: StreamStatus = {
    active_connections: 0,
    emitted_events: 0,
    updated_at_ms: Date.now(),
  };

  constructor({ publish, options = {} }: MarketEngineDeps) {
    this.publish = publish;
    this.maxOpenDurationMs = options.maxOpenDurationMs ?? 90_000;
    this.safetySweepIntervalMs = options.safetySweepIntervalMs ?? 2_000;
    this.triggerCooldownMs = options.triggerCooldownMs ?? 45_000;
    this.enableSafetyTimeouts = options.enableSafetyTimeouts ?? false;
    this.loadState();
    if (!this.findUserByUsername("demo")) {
      this.ensureUser("demo-user-001", "demo", DEFAULT_DEMO_PIN);
      this.ensureWallet("demo-user-001");
      this.persistState();
    }
  }

  start(): void {
    if (!this.enableSafetyTimeouts) return;
    if (this.safetyHandle) return;
    this.safetyHandle = setInterval(() => {
      this.suspendStaleMarkets();
    }, this.safetySweepIntervalMs);
  }

  stop(): void {
    if (this.safetyHandle) {
      clearInterval(this.safetyHandle);
      this.safetyHandle = undefined;
    }
    this.clearAllStockCloseTimers();
  }

  getStreamStatus(): StreamStatus {
    return {
      ...this.streamStatus,
      updated_at_ms: Date.now(),
    };
  }

  setConnectionCount(count: number): void {
    this.streamStatus.active_connections = count;
    this.streamStatus.updated_at_ms = Date.now();
  }

  emitConnectionState(payload: { state: "connected" | "disconnected" | "reconnecting"; server_time_ms: number; socket_id?: string }): void {
    this.emit("connection.state", payload);
  }

  getLiveMarkets(): Market[] {
    return [...this.markets.values()].sort((a, b) => b.timestamps.updated_at_ms - a.timestamps.updated_at_ms);
  }

  getMarket(marketId: string): Market | undefined {
    return this.markets.get(marketId);
  }

  getBetsForUser(userId: string): Bet[] {
    const ids = this.betsByUser.get(userId) ?? [];
    return ids.map((id) => this.bets.get(id)).filter((bet): bet is Bet => Boolean(bet));
  }

  getWallet(userId: string): Wallet {
    return this.ensureWallet(userId);
  }

  getUser(userId: string): PublicUserAccount {
    const user = this.ensureUser(userId);
    return this.toPublicUser(user);
  }

  registerUser(username: string, pin: string): { user: PublicUserAccount; wallet: Wallet } {
    const cleanedUsername = username.trim();
    const cleanedPin = pin.trim();
    const existing = this.findUserByUsername(cleanedUsername);
    if (existing) throw new EngineError("Username already exists", 409);

    const userId = `usr_${randomUUID().slice(0, 8)}`;
    const user = this.ensureUser(userId, cleanedUsername, cleanedPin);
    const wallet = this.ensureWallet(user.user_id);
    this.persistState();

    return {
      user: this.toPublicUser(user),
      wallet,
    };
  }

  loginUser(username: string, pin: string): { user: PublicUserAccount; wallet: Wallet } {
    const found = this.findUserByUsername(username.trim());
    if (!found || found.pin !== pin.trim()) {
      throw new EngineError("Invalid username or PIN", 401);
    }

    return {
      user: this.toPublicUser(found),
      wallet: this.ensureWallet(found.user_id),
    };
  }

  addFunds(userId: string, amount: number): Wallet {
    const wallet = this.ensureWallet(userId);
    wallet.balance += amount;
    wallet.updated_at_ms = Date.now();
    this.wallets.set(wallet.user_id, wallet);
    this.persistState();
    this.emit("wallet.updated", wallet);
    return wallet;
  }

  withdrawFunds(userId: string, amount: number): Wallet {
    const wallet = this.ensureWallet(userId);
    if (wallet.balance < amount) throw new EngineError("Insufficient wallet balance", 400);
    wallet.balance -= amount;
    wallet.updated_at_ms = Date.now();
    this.wallets.set(wallet.user_id, wallet);
    this.persistState();
    this.emit("wallet.updated", wallet);
    return wallet;
  }

  quoteBet(request: BetRequest) {
    const market = this.markets.get(request.market_id);
    if (!market) throw new EngineError("Market not found", 404);
    if (market.status !== "open") throw new EngineError("Market is not open", 400);
    if (!validSelection(market.market_type, request.selection)) {
      throw new EngineError("Selection does not match market type", 400);
    }

    const quote = getQuote(market.amm_state, request.selection, request.stake);
    return {
      market_id: market.market_id,
      selection: request.selection,
      stake: request.stake,
      fee: quote.fee,
      effective_stake: quote.effective_stake,
      estimated_price: quote.estimated_price,
      estimated_price_after: quote.estimated_price_after,
      potential_payout: quote.potential_payout,
      implied_probabilities_before: quote.implied_probabilities_before,
      implied_probabilities_after: quote.implied_probabilities_after,
      quoted_at_ms: Date.now(),
      expires_at_ms: Date.now() + 4_000,
    };
  }

  placeBet(request: BetRequest): PlaceBetResult {
    const market = this.markets.get(request.market_id);
    if (!market) {
      const rejectedBet = this.createRejectedBet(request, "Market not found");
      this.emit("bet.rejected", {
        market_id: rejectedBet.market_id,
        user_id: rejectedBet.user_id,
        reason: rejectedBet.rejection_reason,
        rejected_at_ms: Date.now(),
      });
      return { rejectedBet };
    }

    if (market.status !== "open") return { error: `Market is ${market.status}` };
    if (!validSelection(market.market_type, request.selection)) {
      return { error: "Selection does not match market type" };
    }

    const wallet = this.ensureWallet(request.user_id);
    if (wallet.balance < request.stake) {
      this.emit("bet.rejected", {
        market_id: request.market_id,
        user_id: request.user_id,
        reason: "Insufficient wallet balance",
        rejected_at_ms: Date.now(),
      });
      return { error: "Insufficient wallet balance" };
    }

    const quote = getQuote(market.amm_state, request.selection, request.stake);
    const now = Date.now();

    const bet: Bet = {
      bet_id: randomUUID(),
      user_id: request.user_id,
      market_id: request.market_id,
      selection: request.selection,
      stake: request.stake,
      fee: quote.fee,
      effective_stake: quote.effective_stake,
      accepted_price: quote.estimated_price,
      potential_payout: quote.potential_payout,
      status: "accepted",
      created_at_ms: now,
    };

    market.amm_state = quote.nextAmm;
    market.prices = getImpliedProbabilities(quote.nextAmm);
    market.timestamps.updated_at_ms = now;
    this.markets.set(market.market_id, market);

    wallet.balance -= bet.stake;
    wallet.updated_at_ms = now;
    this.wallets.set(wallet.user_id, wallet);

    this.bets.set(bet.bet_id, bet);
    this.betsByUser.set(bet.user_id, [...(this.betsByUser.get(bet.user_id) ?? []), bet.bet_id]);
    this.persistState();

    this.emit("market.updated", market);
    this.emit("bet.accepted", bet);
    this.emit("wallet.updated", wallet);

    return { bet };
  }

  simulateStarterEvent(input: StarterInput): Market {
    const market = this.buildMarketFromStarter(input);
    this.markets.set(market.market_id, market);
    this.persistState();
    this.emit("market.opened", market);
    return market;
  }

  ingestStarterSignal(signal: StarterSignalInput): { market?: Market; deduped: boolean; reason?: string } {
    const now = Date.now();
    const lastSeen = this.triggerCooldowns.get(signal.cooldown_key);
    if (typeof lastSeen === "number" && now - lastSeen < this.triggerCooldownMs) {
      return { deduped: true, reason: "cooldown_active" };
    }

    const eventType = triggerToEventType(signal.trigger_type);
    const market = this.simulateStarterEvent({
      sport: "F1",
      event_type: eventType,
      session_id: signal.session_id,
      open_duration_ms: signal.market_duration_ms,
      context: {
        source_trigger_type: signal.trigger_type,
        source_event_id: signal.event_id,
        source_timestamp_ms: signal.timestamp_ms,
        source_confidence: signal.confidence,
        lap: signal.lap,
        lap_start: signal.lap,
        driver: signal.driver,
        rival_driver: signal.rival_driver,
        window_seconds: Math.round(signal.market_duration_ms / 1000),
        ...(signal.context ?? {}),
      },
    });

    this.triggerCooldowns.set(signal.cooldown_key, now);
    return { market, deduped: false };
  }

  ingestStockCreateSignal(signal: ScannerStockCreateInputResolved): { market: Market; deduped: boolean; reason?: string } {
    const marketId = this.resolveStockMarketId(signal);
    const existing = this.markets.get(marketId);
    if (existing && existing.status !== "open") {
      return { market: existing, deduped: true, reason: "market_already_finalized" };
    }

    const now = Date.now();
    const sourceTimestamp = signal.timestamp_ms > 0 ? signal.timestamp_ms : now;
    const symbol = signal.symbol.toUpperCase();
    const closeAtMs = signal.close_at_ms;
    const priceAtMs = this.resolveTimestampMs(signal.price_at, sourceTimestamp);

    const nextContext: Record<string, unknown> = {
      ...(existing?.context ?? {}),
      ...(signal.context ?? {}),
      source_event_id: signal.event_id,
      source_signal_type: signal.signal_type,
      scanner_session_id: signal.session_id,
      scanner_confidence: signal.confidence,
      scanner_cooldown_key: signal.cooldown_key,
      market_key: signal.market_key,
      symbol,
      close_at_ms: closeAtMs,
    };

    if (typeof signal.window_minutes === "number" && Number.isFinite(signal.window_minutes)) {
      nextContext.window_minutes = signal.window_minutes;
    }
    if (typeof signal.price === "number" && Number.isFinite(signal.price) && signal.price > 0) {
      nextContext.underlying_last_price = signal.price;
      if (toFiniteNumber(existing?.context.underlying_start_price) === undefined) {
        nextContext.underlying_start_price = signal.price;
      }
    }
    if (priceAtMs > 0) nextContext.underlying_price_at_ms = priceAtMs;
    if (signal.settlement_outcome) {
      nextContext.forced_settlement_outcome = signal.settlement_outcome;
    }

    if (existing) {
      existing.question = signal.question ?? existing.question;
      existing.context = nextContext;
      existing.timestamps.updated_at_ms = now;
      this.markets.set(existing.market_id, existing);
      this.persistState();
      this.emit("market.updated", existing);
      this.scheduleStockMarketClose(
        existing.market_id,
        closeAtMs,
        signal.settlement_outcome,
        "stock_close_time_reached",
      );
      return { market: existing, deduped: true, reason: "market_updated" };
    }

    const market = this.buildMarketFromStarter({
      sport: "Stocks",
      event_type: "stock_up_down_window",
      session_id: signal.session_id,
      context: nextContext,
    });
    market.market_id = marketId;
    market.open_at_ms = sourceTimestamp;
    market.starter_event_id = signal.event_id;
    market.question = signal.question ?? market.question;
    market.timestamps.open_at_ms = sourceTimestamp;
    market.timestamps.updated_at_ms = now;
    market.context = nextContext;

    this.markets.set(market.market_id, market);
    this.persistState();
    this.emit("market.opened", market);
    this.scheduleStockMarketClose(market.market_id, closeAtMs, signal.settlement_outcome, "stock_close_time_reached");

    return { market, deduped: false };
  }

  ingestStockMarketUpdate(signal: ScannerStockUpdateEventInput): Market | undefined {
    const market = this.markets.get(signal.market_id);
    if (!market) return undefined;

    const now = Date.now();
    const nextContext: Record<string, unknown> = {
      ...market.context,
      ...(signal.context ?? {}),
    };
    if (signal.symbol) nextContext.symbol = signal.symbol.toUpperCase();
    if (typeof signal.price === "number" && Number.isFinite(signal.price) && signal.price > 0) {
      nextContext.underlying_last_price = signal.price;
      if (toFiniteNumber(nextContext.underlying_start_price) === undefined) {
        nextContext.underlying_start_price = signal.price;
      }
    }
    if (typeof signal.timestamp_ms === "number" && Number.isFinite(signal.timestamp_ms) && signal.timestamp_ms > 0) {
      nextContext.underlying_price_at_ms = signal.timestamp_ms;
    } else {
      nextContext.underlying_price_at_ms = now;
    }
    if (typeof signal.close_at_ms === "number" && Number.isFinite(signal.close_at_ms) && signal.close_at_ms > 0) {
      nextContext.close_at_ms = signal.close_at_ms;
      if (market.status === "open") {
        this.scheduleStockMarketClose(
          market.market_id,
          signal.close_at_ms,
          this.extractForcedSettlementOutcome(nextContext),
          "stock_close_time_reached",
        );
      }
    }

    market.context = nextContext;
    market.timestamps.updated_at_ms = now;
    this.markets.set(market.market_id, market);
    this.persistState();
    if (market.status === "open") {
      this.emit("market.updated", market);
    }
    return market;
  }

  async closeAndSettleMarketImmediately(
    marketId: string,
    outcome?: Selection,
    options: SettledImmediatelyOptions = {},
  ): Promise<Market | undefined> {
    const market = this.closeMarket(marketId, options.reason ?? "backend_signal");
    if (!market) return undefined;
    const resolvedOutcome = outcome ?? this.deriveSettlementOutcome(market);
    return this.settleMarket(marketId, resolvedOutcome, { skipDelay: true, skipOracleCheck: true });
  }

  closeMarket(marketId: string, reason = "backend_signal"): Market | undefined {
    const market = this.markets.get(marketId);
    if (!market) return undefined;
    if (market.status !== "open") {
      this.clearStockCloseTimer(market.market_id);
      return market;
    }

    const now = Date.now();
    market.status = "closed";
    market.timestamps.closed_at_ms = now;
    market.timestamps.updated_at_ms = now;
    market.context = { ...market.context, close_reason: reason };
    this.markets.set(market.market_id, market);
    this.clearStockCloseTimer(market.market_id);
    this.persistState();
    this.emit("market.closed", market);
    return market;
  }

  async settleMarket(marketId: string, outcome: Selection, options: SettleMarketOptions = {}): Promise<Market | undefined> {
    const market = this.markets.get(marketId);
    if (!market) return undefined;

    if (market.status === "open") this.closeMarket(marketId, "settlement_requested");
    if (market.status !== "closed" && market.status !== "suspended") return market;

    if (!options.skipDelay) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const oracleConfirmed = options.skipOracleCheck ? true : Math.random() <= 0.95;
    if (!oracleConfirmed) {
      market.status = "suspended";
      market.timestamps.updated_at_ms = Date.now();
      market.context = { ...market.context, oracle_rejection: true };
      this.markets.set(market.market_id, market);
      this.persistState();
      this.emit("market.suspended", market);
      return market;
    }

    const now = Date.now();
    const outcomeCanonical = normalizeSelection(outcome);

    for (const bet of this.bets.values()) {
      if (bet.market_id !== market.market_id || bet.status !== "accepted") continue;
      const won = normalizeSelection(bet.selection) === outcomeCanonical;
      bet.status = won ? "settled_won" : "settled_lost";
      bet.payout = won ? bet.potential_payout : 0;
      bet.settled_at_ms = now;
      this.bets.set(bet.bet_id, bet);
      this.emit("bet.updated", bet);

      const wallet = this.ensureWallet(bet.user_id);
      if (won) wallet.balance += bet.payout;
      wallet.updated_at_ms = now;
      this.wallets.set(wallet.user_id, wallet);
      this.emit("wallet.updated", wallet);
    }

    market.status = "settled";
    market.settlement_outcome = outcome;
    market.timestamps.settled_at_ms = now;
    market.timestamps.updated_at_ms = now;
    this.markets.set(market.market_id, market);
    this.clearStockCloseTimer(market.market_id);
    this.emit("market.settled", market);
    this.persistState();

    return market;
  }

  async ingestResolutionSignal(signal: ResolutionSignalInput): Promise<Market | undefined> {
    const market = this.markets.get(signal.market_id);
    if (!market) return undefined;

    market.context = {
      ...market.context,
      resolution_event_id: signal.event_id,
      resolution_confidence: signal.confidence,
      resolution_reason: signal.reason ?? "vision_signal",
      resolution_context: signal.context ?? {},
      resolved_at_ms: signal.resolved_at_ms ?? Date.now(),
    };
    this.markets.set(market.market_id, market);
    this.persistState();

    return this.settleMarket(signal.market_id, signal.outcome, { skipOracleCheck: true });
  }

  reset(): void {
    this.clearAllStockCloseTimers();
    this.markets.clear();
    this.bets.clear();
    this.betsByUser.clear();
    this.triggerCooldowns.clear();
    this.persistState();
  }

  private emit(eventName: PublishEventName, payload: unknown): void {
    this.publish(eventName, payload);
    this.streamStatus.emitted_events += 1;
    this.streamStatus.last_event_name = eventName;
    this.streamStatus.updated_at_ms = Date.now();
  }

  private createRejectedBet(request: BetRequest, reason: string): Bet {
    return {
      bet_id: randomUUID(),
      user_id: request.user_id,
      market_id: request.market_id,
      selection: request.selection,
      stake: request.stake,
      fee: 0,
      effective_stake: 0,
      accepted_price: 0.5,
      potential_payout: 0,
      status: "rejected",
      created_at_ms: Date.now(),
      rejection_reason: reason,
    };
  }

  private ensureWallet(userId: string): Wallet {
    this.ensureUser(userId);
    const existing = this.wallets.get(userId);
    if (existing) return existing;

    const wallet: Wallet = {
      user_id: userId,
      balance: DEFAULT_STARTING_BALANCE,
      updated_at_ms: Date.now(),
    };
    this.wallets.set(userId, wallet);
    return wallet;
  }

  private ensureUser(userId: string, username?: string, pin?: string): UserAccount {
    const existing = this.users.get(userId);
    if (existing) return existing;

    const now = Date.now();
    const user: UserAccount = {
      user_id: userId,
      username: username ?? `user_${userId.slice(-4)}`,
      pin: pin ?? DEFAULT_DEMO_PIN,
      created_at_ms: now,
      updated_at_ms: now,
    };
    this.users.set(userId, user);
    return user;
  }

  private toPublicUser(user: UserAccount): PublicUserAccount {
    const { pin: _pin, ...rest } = user;
    return rest;
  }

  private findUserByUsername(username: string): UserAccount | undefined {
    const normalized = username.trim().toLowerCase();
    return [...this.users.values()].find((user) => user.username.trim().toLowerCase() === normalized);
  }

  private loadState(): void {
    mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
    let legacyMarkets: Market[] = [];
    let resetPersistedMarkets = false;

    if (existsSync(ACCOUNTS_FILE)) {
      try {
        const raw = readFileSync(ACCOUNTS_FILE, "utf8");
        const parsed = JSON.parse(raw) as PersistedAccountsState & { markets?: Market[] };

        for (const user of parsed.users ?? []) this.users.set(user.user_id, user);
        for (const wallet of parsed.wallets ?? []) this.wallets.set(wallet.user_id, wallet);
        for (const pickRow of parsed.picks ?? []) {
          this.bets.set(pickRow.bet_id, pickRow);
          this.betsByUser.set(pickRow.user_id, [...(this.betsByUser.get(pickRow.user_id) ?? []), pickRow.bet_id]);
        }
        legacyMarkets = parsed.markets ?? [];
      } catch {
        this.users.clear();
        this.wallets.clear();
        this.bets.clear();
        this.betsByUser.clear();
      }
    }

    // Markets are runtime-only for MVP: they appear only from explicit API calls.
    // We intentionally clear any persisted/legacy markets on startup.
    if (existsSync(MARKETS_FILE)) {
      try {
        const raw = readFileSync(MARKETS_FILE, "utf8");
        const parsed = JSON.parse(raw) as PersistedMarketsState;
        if ((parsed.markets ?? []).length > 0) {
          resetPersistedMarkets = true;
        }
      } catch {
        // Ignore parse issues and continue with a clean in-memory market state.
      }
    }
    if (legacyMarkets.length > 0) {
      resetPersistedMarkets = true;
    }
    this.markets.clear();
    if (resetPersistedMarkets) {
      this.persistState();
    }
  }

  private persistState(): void {
    const accountsState: PersistedAccountsState = {
      users: [...this.users.values()],
      wallets: [...this.wallets.values()],
      picks: [...this.bets.values()],
    };
    const marketsState: PersistedMarketsState = {
      markets: [...this.markets.values()],
    };
    mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsState, null, 2), "utf8");
    writeFileSync(MARKETS_FILE, JSON.stringify(marketsState, null, 2), "utf8");
  }

  private buildMarketFromStarter(input: StarterInput): Market {
    const now = Date.now();
    const starter_event_id = randomUUID();
    const context: Record<string, unknown> = {
      source_event_type: input.event_type,
      ...(input.context ?? {}),
    };
    let market_type: MarketType = "binary_yes_no";
    let question = "Will this resolve to YES?";

    if (input.sport === "F1") {
      if (input.event_type === "yellow_flag_start") {
        const seconds = typeof context.window_seconds === "number" ? context.window_seconds : 60;
        market_type = "binary_yes_no";
        question = `Will this yellow escalate to Safety Car in ${Math.round(seconds)}s?`;
      } else if (input.event_type === "pit_state_change") {
        const driver = displayName(context.driver);
        const rival = displayName(context.rival_driver);
        market_type = "binary_yes_no";
        question = `Will ${driver} rejoin ahead of ${rival}?`;
      } else if (input.event_type === "battle_window_start") {
        const attacker = displayName(context.driver);
        const defender = displayName(context.rival_driver);
        market_type = "binary_yes_no";
        question = `Will ${attacker} overtake ${defender} within the next lap?`;
      } else if (input.event_type === "safety_car_start") {
        market_type = "binary_yes_no";
        question = "Will the safety car be on for longer than 3.5 laps?";
      } else {
        const [driverA, driverB] = Array.isArray(context.drivers) ? (context.drivers as string[]) : pick(F1_DRIVERS);
        const laps =
          typeof context.laps === "number"
            ? Math.max(1, Math.floor(context.laps))
            : pick([1, 2, 3, 5]);
        const a = typeof context.driver_a === "string" ? context.driver_a : driverA;
        const b = typeof context.driver_b === "string" ? context.driver_b : driverB;
        context.driver_a = a;
        context.driver_b = b;
        context.laps = laps;
        market_type = "binary_yes_no";
        question = `Will ${a} overtake ${b} within ${laps} laps?`;
      }
    }

    if (input.sport === "Stocks") {
      market_type = "binary_higher_lower";
      const symbol = typeof context.symbol === "string" ? context.symbol.toUpperCase() : pick(VOLATILE_STOCKS);
      const windowMinutes =
        typeof context.window_minutes === "number"
          ? Math.max(1, Math.floor(context.window_minutes))
          : 5;
      context.symbol = symbol;
      context.window_minutes = windowMinutes;
      question = `Will price be HIGHER in the next ${windowMinutes} minutes?`;
    }
    const customQuestion = typeof context.custom_question === "string" ? context.custom_question.trim() : "";
    if (customQuestion) {
      question = customQuestion;
    }

    const market_id = `mkt_${input.sport.toLowerCase()}_${now}_${starter_event_id.slice(0, 6)}`;
    const requestedDurationMs =
      typeof input.open_duration_ms === "number" ? input.open_duration_ms : this.maxOpenDurationMs;
    const safetyTimeoutEnabled = this.enableSafetyTimeouts && input.sport !== "F1";
    const marketDurationMs = safetyTimeoutEnabled
      ? clamp(requestedDurationMs, MIN_MARKET_DURATION_MS, MAX_MARKET_DURATION_MS)
      : 0;
    const amm_state = createAmmState(DEFAULT_INITIAL_PROBABILITY, DEFAULT_VIRTUAL_LIQUIDITY, DEFAULT_FEE_BPS);

    return {
      market_id,
      sport: input.sport,
      session_id: input.session_id ?? `${input.sport.toLowerCase()}-session-${now}`,
      market_type,
      question,
      context,
      open_at_ms: now,
      settlement_key: `${input.sport.toLowerCase()}_${input.event_type}`,
      starter_event_id,
      close_control: {
        mode: "backend_signal",
        closer_key: "mock_closer_v1",
      },
      market_making: {
        model: "binary_amm",
        initial_probability_yes: DEFAULT_INITIAL_PROBABILITY,
        virtual_liquidity: DEFAULT_VIRTUAL_LIQUIDITY,
        fee_bps: DEFAULT_FEE_BPS,
      },
      status: "open",
      amm_state,
      prices: getImpliedProbabilities(amm_state),
      timestamps: {
        open_at_ms: now,
        updated_at_ms: now,
      },
      safety: {
        max_open_duration_ms: marketDurationMs,
        expires_at_ms: safetyTimeoutEnabled ? now + marketDurationMs : 0,
        timeout_triggered: false,
      },
    };
  }

  private resolveStockMarketId(signal: ScannerStockCreateInputResolved): string {
    const raw = signal.market_id?.trim() || `mkt_stocks_${signal.market_key}_${signal.event_id}`;
    const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (normalized.length > 0) return normalized;
    return `mkt_stocks_${Date.now()}`;
  }

  private resolveTimestampMs(value: unknown, fallbackMs: number): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === "string") {
      const parsedNumeric = Number(value);
      if (Number.isFinite(parsedNumeric) && parsedNumeric > 0) {
        return Math.floor(parsedNumeric);
      }
      const parsedDate = Date.parse(value);
      if (Number.isFinite(parsedDate) && parsedDate > 0) {
        return parsedDate;
      }
    }
    return fallbackMs;
  }

  private scheduleStockMarketClose(
    marketId: string,
    closeAtMs: number,
    forcedOutcome?: Selection,
    reason = "stock_close_time_reached",
  ): void {
    if (!Number.isFinite(closeAtMs) || closeAtMs <= 0) return;
    this.clearStockCloseTimer(marketId);

    const run = () => {
      this.stockCloseTimers.delete(marketId);
      void this.closeAndSettleMarketImmediately(marketId, forcedOutcome, { reason });
    };

    const delayMs = Math.floor(closeAtMs - Date.now());
    if (delayMs <= 0) {
      run();
      return;
    }

    const timer = setTimeout(run, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.stockCloseTimers.set(marketId, timer);
  }

  private clearStockCloseTimer(marketId: string): void {
    const timer = this.stockCloseTimers.get(marketId);
    if (!timer) return;
    clearTimeout(timer);
    this.stockCloseTimers.delete(marketId);
  }

  private clearAllStockCloseTimers(): void {
    for (const timer of this.stockCloseTimers.values()) {
      clearTimeout(timer);
    }
    this.stockCloseTimers.clear();
  }

  private extractForcedSettlementOutcome(source: unknown): Selection | undefined {
    if (!source || typeof source !== "object") return undefined;
    const record = source as Record<string, unknown>;
    const candidates = [
      record.forced_settlement_outcome,
      record.settlement_outcome,
      record.expected_outcome,
      record.outcome,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const normalized = candidate.toUpperCase();
      if (normalized === "YES" || normalized === "NO" || normalized === "HIGHER" || normalized === "LOWER") {
        return normalized;
      }
    }
    return undefined;
  }

  private deriveSettlementOutcome(market: Market): Selection {
    const forced = this.extractForcedSettlementOutcome(market.context);
    if (forced) {
      if (market.market_type === "binary_higher_lower" && (forced === "HIGHER" || forced === "LOWER")) return forced;
      if (market.market_type === "binary_yes_no" && (forced === "YES" || forced === "NO")) return forced;
    }

    if (market.market_type === "binary_higher_lower") {
      const start = toFiniteNumber(market.context.underlying_start_price);
      const latest = toFiniteNumber(market.context.underlying_last_price);
      if (start !== undefined && latest !== undefined) {
        return latest >= start ? "HIGHER" : "LOWER";
      }
      const finalMove = toFiniteNumber(market.context.final_move_from_start_pct);
      if (finalMove !== undefined) {
        return finalMove >= 0 ? "HIGHER" : "LOWER";
      }
      return "HIGHER";
    }

    return "YES";
  }

  private suspendStaleMarkets(): void {
    if (!this.enableSafetyTimeouts) return;
    const now = Date.now();
    let changed = false;
    for (const market of this.markets.values()) {
      if (market.status !== "open") continue;
      if (isF1Market(market)) continue;
      if (market.safety.max_open_duration_ms <= 0) continue;
      if (now <= market.safety.expires_at_ms) continue;

      market.status = "suspended";
      market.safety.timeout_triggered = true;
      market.timestamps.suspended_at_ms = now;
      market.timestamps.updated_at_ms = now;
      market.context = { ...market.context, suspension_reason: "safety_timeout" };
      this.markets.set(market.market_id, market);
      this.emit("market.suspended", market);
      changed = true;
    }
    if (changed) this.persistState();
  }
}
