import { create } from "zustand";

import type { Bet, ConnectionState, Market, UserAccount, Wallet } from "../types/contracts";

type State = {
  userId: string;
  isAuthenticated: boolean;
  account?: UserAccount;
  markets: Market[];
  bets: Bet[];
  wallet?: Wallet;
  connection: ConnectionState;
  setSession: (payload: { userId: string; account: UserAccount; wallet: Wallet }) => void;
  clearSession: () => void;
  setAccount: (account?: UserAccount) => void;
  setMarkets: (markets: Market[]) => void;
  upsertMarket: (market: Market) => void;
  setBets: (bets: Bet[]) => void;
  upsertBet: (bet: Bet) => void;
  setWallet: (wallet: Wallet) => void;
  setConnection: (connection: ConnectionState) => void;
};

const byUpdated = (a: Market, b: Market) => b.timestamps.updated_at_ms - a.timestamps.updated_at_ms;

export const useAppStore = create<State>((set) => ({
  userId: "",
  isAuthenticated: false,
  account: undefined,
  markets: [],
  bets: [],
  connection: "disconnected",
  setSession: ({ userId, account, wallet }) =>
    set({
      userId,
      account,
      wallet,
      isAuthenticated: true,
      bets: [],
    }),
  clearSession: () =>
    set({
      userId: "",
      isAuthenticated: false,
      account: undefined,
      wallet: undefined,
      bets: [],
      connection: "disconnected",
    }),
  setAccount: (account) => set({ account }),
  setMarkets: (markets) => set({ markets: [...markets].sort(byUpdated) }),
  upsertMarket: (market) =>
    set((state) => ({
      markets: [market, ...state.markets.filter((m) => m.market_id !== market.market_id)].sort(byUpdated),
    })),
  setBets: (bets) => set({ bets: [...bets].sort((a, b) => b.created_at_ms - a.created_at_ms) }),
  upsertBet: (bet) =>
    set((state) => ({
      bets: [bet, ...state.bets.filter((b) => b.bet_id !== bet.bet_id)].sort((a, b) => b.created_at_ms - a.created_at_ms),
    })),
  setWallet: (wallet) => set({ wallet }),
  setConnection: (connection) => set({ connection }),
}));
