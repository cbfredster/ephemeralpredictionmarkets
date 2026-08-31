import "dotenv/config";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";

import { MarketEngine } from "./engine";
import { MockBetCloserService, MockBetStarterService, type BetCloseTrigger, type BetStarterEvent } from "./mock-services";
import { registerRoutes } from "./routes";
import { registerStripeRoutes } from "./stripe-routes";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true, credentials: true });

const io = new SocketIOServer(fastify.server, {
  cors: { origin: "*", credentials: true },
  transports: ["websocket", "polling"],
});

const engine = new MarketEngine({
  options: {
    enableSafetyTimeouts: false,
  },
  publish: (eventName, payload) => {
    io.emit(eventName, payload);
  },
});

const starter = new MockBetStarterService(
  (event: BetStarterEvent) => {
    engine.simulateStarterEvent({
      sport: event.sport,
      event_type: event.event_type,
      session_id: event.session_id,
      context: event.context,
    });
  },
  {
    intervalMs: 0,
  },
);

const closer = new MockBetCloserService(async (trigger: BetCloseTrigger) => {
  const market = engine.getMarket(trigger.market_id);
  if (!market) return;

  engine.closeMarket(trigger.market_id, trigger.reason);

  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const outcome =
    market.market_type === "binary_higher_lower"
      ? (Math.random() < 0.5 ? "HIGHER" : "LOWER")
      : (Math.random() < 0.5 ? "YES" : "NO");

  await engine.settleMarket(trigger.market_id, outcome as "YES" | "NO" | "HIGHER" | "LOWER");
});

engine.start();
// No seed/auto events — markets only appear from explicit API-triggered calls.

registerRoutes(fastify, engine, starter, closer);
registerStripeRoutes(fastify, engine);

io.on("connection", (socket) => {
  engine.setConnectionCount(io.engine.clientsCount);

  socket.emit("connection.state", {
    state: "connected",
    server_time_ms: Date.now(),
    socket_id: socket.id,
  });

  socket.on("disconnect", () => {
    engine.setConnectionCount(io.engine.clientsCount);
    engine.emitConnectionState({
      state: "disconnected",
      server_time_ms: Date.now(),
      socket_id: socket.id,
    });
  });
});

const shutdown = async (): Promise<void> => {
  starter.stop();
  engine.stop();
  io.close();
  await fastify.close();
};

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`API listening at http://${HOST}:${PORT}`);
} catch (error) {
  fastify.log.error(error);
  await shutdown();
  process.exit(1);
}
