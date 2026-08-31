import { io, type Socket } from "socket.io-client";

import type { Bet, Market, Wallet } from "../types/contracts";
import { WS_URL } from "../utils/network";

type Handlers = {
  onConnection: (state: "connected" | "disconnected" | "reconnecting") => void;
  onMarket: (market: Market) => void;
  onBet: (bet: Bet) => void;
  onWallet: (wallet: Wallet) => void;
};

export const connectSocket = (handlers: Handlers): Socket => {
  const socket = io(WS_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelayMax: 6000,
  });

  socket.on("connect", () => handlers.onConnection("connected"));
  socket.on("disconnect", () => handlers.onConnection("disconnected"));
  socket.io.on("reconnect_attempt", () => handlers.onConnection("reconnecting"));

  socket.on("market.opened", handlers.onMarket);
  socket.on("market.updated", handlers.onMarket);
  socket.on("market.closed", handlers.onMarket);
  socket.on("market.settled", handlers.onMarket);
  socket.on("market.suspended", handlers.onMarket);

  socket.on("bet.accepted", handlers.onBet);
  socket.on("bet.updated", handlers.onBet);
  socket.on("wallet.updated", handlers.onWallet);

  return socket;
};
