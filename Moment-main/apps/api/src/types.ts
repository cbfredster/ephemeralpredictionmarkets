import { z } from "zod";

export const sportSchema = z.enum(["F1", "Stocks"]);
export const marketTypeSchema = z.enum(["binary_yes_no", "binary_higher_lower"]);
export const marketStatusSchema = z.enum(["open", "closed", "settled", "suspended"]);
export const selectionSchema = z.enum(["YES", "NO", "HIGHER", "LOWER"]);

export const betRequestSchema = z.object({
  user_id: z.string().min(1),
  market_id: z.string().min(1),
  selection: selectionSchema,
  stake: z.number().positive(),
});

export const quoteRequestSchema = betRequestSchema;

export const marketIdParamSchema = z.object({
  marketId: z.string().min(1),
});

export const userIdParamSchema = z.object({
  userId: z.string().min(1),
});

export const createUserBodySchema = z.object({
  username: z.string().trim().min(2).max(32),
  pin: z.string().trim().min(4).max(12),
});

export const loginBodySchema = z.object({
  username: z.string().trim().min(2).max(32),
  pin: z.string().trim().min(4).max(12),
});

export const userFundsBodySchema = z.object({
  amount: z.number().positive(),
});

export const starterEventBodySchema = z.object({
  sport: sportSchema.optional(),
  event_type: z.string().optional(),
  session_id: z.string().optional(),
  context: z.record(z.string(), z.any()).optional(),
  open_duration_ms: z.number().int().min(30_000).max(900_000).optional(),
});

export const closeMarketBodySchema = z.object({
  market_id: z.string().min(1),
  reason: z.string().optional(),
});

export const settleMarketBodySchema = z.object({
  market_id: z.string().min(1),
  outcome: selectionSchema.optional(),
});

export const triggerTypeSchema = z.enum(["YELLOW_FLAG_START", "PIT_STATE_CHANGE", "BATTLE_WINDOW_START", "SAFETY_CAR_START"]);

export const starterSignalBodySchema = z.object({
  event_id: z.string().min(1),
  sport: z.literal("F1").default("F1"),
  trigger_type: triggerTypeSchema,
  session_id: z.string().min(1),
  timestamp_ms: z.number().nonnegative(),
  lap: z.number().int().positive().optional(),
  driver: z.string().optional(),
  rival_driver: z.string().optional(),
  confidence: z.number().min(0).max(1),
  cooldown_key: z.string().min(1),
  market_duration_ms: z.number().int().min(30_000).max(900_000).default(60_000),
  context: z.record(z.string(), z.any()).optional(),
});

export const resolutionSignalBodySchema = z.object({
  event_id: z.string().min(1),
  market_id: z.string().min(1),
  outcome: selectionSchema,
  confidence: z.number().min(0).max(1),
  resolved_at_ms: z.number().nonnegative().optional(),
  reason: z.string().optional(),
  context: z.record(z.string(), z.any()).optional(),
});

export const scannerCreateEventBodySchema = z.object({
  event_id: z.string().min(1),
  signal_type: z.literal("create_bet"),
  sport: z.literal("F1").default("F1"),
  trigger_type: triggerTypeSchema,
  session_id: z.string().min(1),
  timestamp_ms: z.number().nonnegative(),
  lap: z.number().int().positive().optional(),
  driver: z.string().optional(),
  rival_driver: z.string().optional(),
  confidence: z.number().min(0).max(1),
  cooldown_key: z.string().min(1),
  market_duration_ms: z.number().int().min(30_000).max(900_000).default(60_000),
  context: z.record(z.string(), z.any()).optional(),
});

export const scannerStockCreateEventBodySchema = z.object({
  event_id: z.string().min(1),
  signal_type: z.literal("create_bet"),
  sport: z.literal("Stocks"),
  session_id: z.string().min(1),
  timestamp_ms: z.number().nonnegative(),
  market_id: z.string().min(1).optional(),
  market_key: z.string().min(1),
  symbol: z.string().trim().min(1),
  close_at_ms: z.number().int().nonnegative().optional(),
  close_at: z.string().trim().min(1).optional(),
  close_time: z.string().trim().min(1).optional(),
  expires_at: z.string().trim().min(1).optional(),
  confidence: z.number().min(0).max(1).default(1),
  cooldown_key: z.string().min(1),
  window_minutes: z.number().int().positive().optional(),
  question: z.string().trim().min(5).optional(),
  settlement_outcome: z.enum(["HIGHER", "LOWER"]).optional(),
  price: z.number().positive().optional(),
  price_at: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]).optional(),
  context: z.record(z.string(), z.any()).optional(),
});

export const scannerStockUpdateEventBodySchema = z.object({
  event_id: z.string().min(1).optional(),
  signal_type: z.literal("market_update"),
  sport: z.literal("Stocks").default("Stocks"),
  market_id: z.string().min(1),
  timestamp_ms: z.number().nonnegative().optional(),
  symbol: z.string().trim().min(1).optional(),
  price: z.number().positive().optional(),
  close_at_ms: z.number().int().nonnegative().optional(),
  context: z.record(z.string(), z.any()).optional(),
});

export const scannerCloseEventBodySchema = z.object({
  event_id: z.string().min(1),
  signal_type: z.literal("close_bet"),
  market_id: z.string().min(1),
  sport: sportSchema.optional(),
  settlement_outcome: z.enum(["HIGHER", "LOWER"]).optional(),
  timestamp_ms: z.number().nonnegative().optional(),
  reason: z.string().optional(),
  context: z.record(z.string(), z.any()).optional(),
});

export const scannerEventBodySchema = z.union([
  scannerCreateEventBodySchema,
  scannerStockCreateEventBodySchema,
  scannerStockUpdateEventBodySchema,
  scannerCloseEventBodySchema,
]);

export const scannerLifecycleEventBodySchema = z.object({
  event: z.enum(["event_created", "event_active", "event_closed"]),
  event_state: z.string().optional(),
  event_at: z.string().trim().min(1).optional(),
  expires_at: z.string().trim().min(1).optional(),
  settle_at: z.string().trim().min(1).optional(),
  event_id: z.union([z.string(), z.number()]).optional(),
  event_type: z.string().trim().min(1).optional(),
  market_id: z.string().trim().min(1).optional(),
  ticker: z.string().trim().min(1).optional(),
  question: z.string().trim().min(1).optional(),
  target_direction: z.enum(["UP", "DOWN"]).optional(),
  target_hit: z.boolean().optional(),
  final_move_from_start_pct: z.number().optional(),
  price: z.number().positive().optional(),
  final_price: z.number().positive().optional(),
  price_at: z.string().trim().min(1).optional(),
  close_reason: z.string().trim().min(1).optional(),
  context: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  event_payload: z.record(z.string(), z.any()).optional(),
});

export type Sport = z.infer<typeof sportSchema>;
export type MarketType = z.infer<typeof marketTypeSchema>;
export type MarketStatus = z.infer<typeof marketStatusSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type BetRequest = z.infer<typeof betRequestSchema>;
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type CreateUserBody = z.infer<typeof createUserBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type TriggerType = z.infer<typeof triggerTypeSchema>;

export type AmmState = {
  yes_pool: number;
  no_pool: number;
  fee_bps: number;
  virtual_liquidity: number;
  total_fees_collected: number;
  total_volume: number;
  trade_count: number;
};

export type Market = {
  market_id: string;
  sport: Sport;
  session_id: string;
  market_type: MarketType;
  question: string;
  context: Record<string, unknown>;
  open_at_ms: number;
  settlement_key: string;
  starter_event_id: string;
  close_control: {
    mode: "backend_signal";
    closer_key: string;
  };
  market_making: {
    model: "binary_amm";
    initial_probability_yes: number;
    virtual_liquidity: number;
    fee_bps: number;
  };
  status: MarketStatus;
  amm_state: AmmState;
  prices: { yes: number; no: number };
  timestamps: {
    open_at_ms: number;
    updated_at_ms: number;
    closed_at_ms?: number;
    settled_at_ms?: number;
    suspended_at_ms?: number;
  };
  settlement_outcome?: Selection;
  safety: {
    max_open_duration_ms: number;
    expires_at_ms: number;
    timeout_triggered: boolean;
  };
};

export type BetStatus = "accepted" | "rejected" | "settled_won" | "settled_lost";

export type Bet = {
  bet_id: string;
  user_id: string;
  market_id: string;
  selection: Selection;
  stake: number;
  fee: number;
  effective_stake: number;
  accepted_price: number;
  potential_payout: number;
  status: BetStatus;
  payout?: number;
  created_at_ms: number;
  settled_at_ms?: number;
  rejection_reason?: string;
};

export type Wallet = {
  user_id: string;
  balance: number;
  updated_at_ms: number;
};

export type UserAccount = {
  user_id: string;
  username: string;
  pin: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export type PublicUserAccount = Omit<UserAccount, "pin">;

export type StreamStatus = {
  active_connections: number;
  emitted_events: number;
  last_event_name?: string;
  updated_at_ms: number;
};

export type StarterInput = {
  sport: Sport;
  event_type: string;
  session_id?: string;
  context?: Record<string, unknown>;
  open_duration_ms?: number;
};

export type StarterSignalInput = z.infer<typeof starterSignalBodySchema>;
export type ResolutionSignalInput = z.infer<typeof resolutionSignalBodySchema>;
export type ScannerEventInput = z.infer<typeof scannerEventBodySchema>;
export type ScannerStockCreateEventInput = z.infer<typeof scannerStockCreateEventBodySchema>;
export type ScannerStockUpdateEventInput = z.infer<typeof scannerStockUpdateEventBodySchema>;
export type ScannerLifecycleEventInput = z.infer<typeof scannerLifecycleEventBodySchema>;

export type PublishEventName =
  | "market.opened"
  | "market.updated"
  | "market.closed"
  | "market.settled"
  | "market.suspended"
  | "bet.accepted"
  | "bet.updated"
  | "bet.rejected"
  | "wallet.updated"
  | "connection.state";
