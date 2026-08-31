import type { Bet, BetQuote, BetRequest, Market, Selection, UserAccount, Wallet } from "../types/contracts";
import { API_URL } from "../utils/network";

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const extractMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const nested = parseJson(trimmed);
    if (nested !== undefined) {
      return extractMessage(nested) ?? trimmed;
    }
    return trimmed;
  }

  if (Array.isArray(value)) {
    const messages = value.map((entry) => extractMessage(entry)).filter((entry): entry is string => Boolean(entry));
    return messages.length ? messages.join(", ") : undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("message" in record) {
      const msg = extractMessage(record.message);
      if (msg) return msg;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
    if (typeof record.code === "string") {
      return record.code;
    }
  }

  return undefined;
};

const req = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  const text = await res.text();
  const data = text ? parseJson(text) : undefined;

  if (!res.ok) {
    const message = extractMessage(data ?? text) ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return (data ?? text) as T;
};

export const api = {
  getLiveMarkets: () => req<Market[]>("/markets/live"),
  getMarket: (marketId: string) => req<Market>(`/markets/${marketId}`),
  getBets: (userId: string) => req<Bet[]>(`/picks/${userId}`),
  getUser: (userId: string) => req<UserAccount>(`/users/${userId}`),
  getWallet: (userId: string) => req<Wallet>(`/users/${userId}/wallet`),
  createUser: (payload: { username: string; pin: string }) =>
    req<{ user: UserAccount; wallet: Wallet }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  login: (payload: { username: string; pin: string }) =>
    req<{ user: UserAccount; wallet: Wallet }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  addFunds: (userId: string, amount: number) =>
    req<{ wallet: Wallet }>(`/users/${userId}/funds/add`, {
      method: "POST",
      body: JSON.stringify({ amount }),
    }),
  withdrawFunds: (userId: string, amount: number) =>
    req<{ wallet: Wallet }>(`/users/${userId}/funds/withdraw`, {
      method: "POST",
      body: JSON.stringify({ amount }),
    }),
  stripeCreatePaymentIntent: (userId: string, amountCents: number) =>
    req<{ clientSecret: string }>("/stripe/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ userId, amount: amountCents }),
    }),
  stripeCreatePayout: (userId: string, amountCents: number) =>
    req<{ ok: boolean; wallet: Wallet }>("/stripe/create-payout", {
      method: "POST",
      body: JSON.stringify({ userId, amount: amountCents }),
    }),
  quote: (payload: BetRequest) =>
    req<BetQuote>("/quotes", { method: "POST", body: JSON.stringify(payload) }),
  placeBet: (payload: BetRequest) =>
    req<Bet>("/picks", { method: "POST", body: JSON.stringify(payload) }),
  triggerStarter: (payload?: {
    sport?: "F1" | "Stocks";
    event_type?: string;
    session_id?: string;
    context?: Record<string, unknown>;
  }) =>
    req("/dev/simulate/starter-event", {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  closeMarket: (marketId: string) =>
    req("/dev/simulate/close-market", { method: "POST", body: JSON.stringify({ market_id: marketId }) }),
  settleMarket: (marketId: string, outcome?: Selection) =>
    req("/dev/simulate/settle-market", {
      method: "POST",
      body: JSON.stringify({ market_id: marketId, outcome }),
    }),
  reset: () => req("/dev/simulate/reset", { method: "POST", body: "{}" }),
};

export { ApiError };
