export type Sport = "F1" | "Stocks";
export type MarketType = "binary_yes_no" | "binary_higher_lower";
export type MarketStatus = "open" | "closed" | "settled" | "suspended";
export type Selection = "YES" | "NO" | "HIGHER" | "LOWER";

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
  close_control: { mode: "backend_signal"; closer_key: string };
  market_making: {
    model: "binary_amm";
    initial_probability_yes: number;
    virtual_liquidity: number;
    fee_bps: number;
  };
  status: MarketStatus;
  amm_state: {
    yes_pool: number;
    no_pool: number;
    fee_bps: number;
    virtual_liquidity: number;
    total_fees_collected: number;
    total_volume: number;
    trade_count: number;
  };
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
  created_at_ms: number;
  updated_at_ms: number;
};

export type BetRequest = {
  user_id: string;
  market_id: string;
  selection: Selection;
  stake: number;
};

export type BetQuote = {
  market_id: string;
  selection: Selection;
  stake: number;
  fee: number;
  effective_stake: number;
  estimated_price: number;
  estimated_price_after: number;
  potential_payout: number;
  implied_probabilities_before: { yes: number; no: number };
  implied_probabilities_after: { yes: number; no: number };
  quoted_at_ms: number;
  expires_at_ms: number;
};

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";
