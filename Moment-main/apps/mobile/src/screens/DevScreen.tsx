import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import { colors, layout } from "../theme/tokens";

const STOCK_SYMBOLS = ["TSLA", "NVDA", "COIN", "MSTR", "PLTR", "SMCI"];
const F1_PAIRS = [
  ["Norris", "Verstappen"],
  ["Leclerc", "Piastri"],
  ["Hamilton", "Russell"],
  ["Sainz", "Alonso"],
] as const;
const LAPS = [1, 2, 3, 5];

const randomFrom = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export function DevScreen() {
  const { userId, markets, connection, setMarkets, setBets, setWallet } = useAppStore();
  const [busy, setBusy] = useState(false);

  const firstOpen = useMemo(() => markets.find((m) => m.status === "open"), [markets]);
  const firstClosed = useMemo(() => markets.find((m) => m.status === "closed"), [markets]);

  const refresh = useCallback(async () => {
    const [nextMarkets, nextBets, nextWallet] = await Promise.all([
      api.getLiveMarkets(),
      api.getBets(userId),
      api.getWallet(userId),
    ]);
    setMarkets(nextMarkets);
    setBets(nextBets);
    setWallet(nextWallet);
  }, [setBets, setMarkets, setWallet, userId]);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      setBusy(true);
      try {
        await task();
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Dev Controls</Text>
        <Text style={styles.meta}>Connection: {connection}</Text>
        <Text style={styles.meta}>Markets: {markets.length}</Text>

        <View style={styles.block}>
          <Text style={styles.blockTitle}>Generate Markets</Text>
          <Pressable
            style={styles.btn}
            disabled={busy}
            onPress={() =>
              run(async () => {
                const [driver_a, driver_b] = randomFrom(F1_PAIRS);
                await api.triggerStarter({
                  sport: "F1",
                  event_type: "overtake_in_x_laps",
                  context: {
                    driver_a,
                    driver_b,
                    laps: randomFrom(LAPS),
                  },
                });
              })
            }
          >
            <Text style={styles.btnText}>Generate F1 Overtake Market</Text>
          </Pressable>

          <Pressable
            style={styles.btn}
            disabled={busy}
            onPress={() =>
              run(async () => {
                await api.triggerStarter({
                  sport: "Stocks",
                  event_type: "stock_up_down_window",
                  context: {
                    symbol: randomFrom(STOCK_SYMBOLS),
                    window_minutes: randomFrom([3, 5, 8, 10]),
                  },
                });
              })
            }
          >
            <Text style={styles.btnText}>Generate Stock Market</Text>
          </Pressable>
        </View>

        <View style={styles.block}>
          <Text style={styles.blockTitle}>Lifecycle</Text>
          <Pressable
            style={styles.btn}
            disabled={busy || !firstOpen}
            onPress={() =>
              run(async () => {
                if (firstOpen) await api.closeMarket(firstOpen.market_id);
              })
            }
          >
            <Text style={styles.btnText}>Close First Open Market</Text>
          </Pressable>

          <Pressable
            style={styles.btn}
            disabled={busy || (!firstOpen && !firstClosed)}
            onPress={() =>
              run(async () => {
                const target = firstClosed ?? firstOpen;
                if (target) await api.settleMarket(target.market_id);
              })
            }
          >
            <Text style={styles.btnText}>Settle First Market</Text>
          </Pressable>

          <Pressable
            style={styles.btn}
            disabled={busy}
            onPress={() =>
              run(async () => {
                await api.reset();
              })
            }
          >
            <Text style={styles.btnText}>Reset Simulation</Text>
          </Pressable>

          <Pressable
            style={styles.btn}
            disabled={busy}
            onPress={() =>
              run(async () => {
                await Promise.resolve();
              })
            }
          >
            <Text style={styles.btnText}>Refresh</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 14,
    gap: 14,
    paddingBottom: 130,
  },
  title: {
    color: colors.text,
    fontSize: 30,
    fontWeight: "900",
  },
  meta: {
    color: colors.muted,
    fontWeight: "600",
  },
  block: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusMd,
    padding: 12,
    gap: 10,
    backgroundColor: colors.card,
  },
  blockTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
  },
  btn: {
    borderRadius: layout.radiusSm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#153255",
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  btnText: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 13,
  },
});
