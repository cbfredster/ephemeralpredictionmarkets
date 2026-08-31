import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";

import { StakeModal } from "../components/StakeModal";
import { TradingViewPanel } from "../components/TradingViewPanel";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import { colors, gradients, layout } from "../theme/tokens";
import type { Market, Selection } from "../types/contracts";

const getSymbol = (market: Market): string => {
  const raw = market.context.symbol;
  return typeof raw === "string" ? raw.toUpperCase() : "TSLA";
};

const positiveSelectionFor = (market: Market): Selection =>
  market.market_type === "binary_higher_lower" ? "HIGHER" : "YES";

const negativeSelectionFor = (market: Market): Selection =>
  market.market_type === "binary_higher_lower" ? "LOWER" : "NO";

const formatPercent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function StocksScreen() {
  const { userId, markets, bets, wallet, setMarkets, setBets, setWallet } = useAppStore();
  const [modalMarketId, setModalMarketId] = useState<string>();
  const [modalSelection, setModalSelection] = useState<Selection>();
  const [modalVisible, setModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activePick, setActivePick] = useState<{ marketId: string; selection: Selection }>();

  const stockMarkets = useMemo(() => markets.filter((market) => market.sport === "Stocks"), [markets]);
  const modalMarket = useMemo(
    () => (modalMarketId ? markets.find((market) => market.market_id === modalMarketId) : undefined),
    [markets, modalMarketId],
  );

  const stockMarketIds = useMemo(() => new Set(stockMarkets.map((m) => m.market_id)), [stockMarkets]);
  const stockBets = useMemo(
    () => bets.filter((bet) => stockMarketIds.has(bet.market_id) && bet.status === "accepted"),
    [bets, stockMarketIds],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextMarkets, nextBets, nextWallet] = await Promise.all([
        api.getLiveMarkets(),
        api.getBets(userId),
        api.getWallet(userId),
      ]);
      setMarkets(nextMarkets);
      setBets(nextBets);
      setWallet(nextWallet);
    } finally {
      setRefreshing(false);
    }
  }, [setBets, setMarkets, setWallet, userId]);

  const openStake = useCallback((market: Market, selection: Selection) => {
    setModalMarketId(market.market_id);
    setModalSelection(selection);
    setActivePick({ marketId: market.market_id, selection });
    setModalVisible(true);
  }, []);

  const closeStake = useCallback(() => {
    setModalVisible(false);
    setModalMarketId(undefined);
    setActivePick(undefined);
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <LinearGradient colors={gradients.heroStocks} style={styles.hero}>
        <View style={styles.heroTop}>
          <Text style={styles.title}>Volatility</Text>
          <View style={styles.liveChip}>
            <Text style={styles.liveChipText}>FAST PICKS</Text>
          </View>
        </View>
        <Text style={styles.subtitle}>Pick if the next move is UP or DOWN</Text>
        <View style={styles.metaRow}>
          <Text style={styles.meta}>Wallet €{wallet?.balance.toFixed(2) ?? "--"}</Text>
          <Text style={styles.meta}>{stockBets.length} active picks</Text>
        </View>
      </LinearGradient>

      <FlatList
        data={stockMarkets}
        keyExtractor={(item) => item.market_id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accentBlue} />}
        renderItem={({ item }) => {
          const symbol = getSymbol(item);
          const freshnessMs = Date.now() - item.timestamps.updated_at_ms;
          const liveLabel = item.status === "open" ? (freshnessMs < 4_000 ? "LIVE" : freshnessMs < 15_000 ? "ACTIVE" : "") : "";
          const positiveSelection = positiveSelectionFor(item);
          const negativeSelection = negativeSelectionFor(item);
          const isDownSelected =
            activePick?.marketId === item.market_id && activePick.selection === negativeSelection;
          const isUpSelected =
            activePick?.marketId === item.market_id && activePick.selection === positiveSelection;
          return (
            <View style={styles.windowCard}>
              <View style={styles.titleRow}>
                <Text style={styles.windowQuestion}>{item.question}</Text>
                {liveLabel ? (
                  <View style={styles.livePill}>
                    <View style={styles.liveDot} />
                    <Text style={styles.liveText}>{liveLabel}</Text>
                  </View>
                ) : null}
              </View>
              <TradingViewPanel symbol={symbol} height={180} />
              <View style={styles.actionRow}>
                <Pressable
                  style={[styles.sideButton, styles.sideDown, isDownSelected && styles.sideButtonSelectedDown]}
                  onPress={() => openStake(item, negativeSelection)}
                >
                  <Text style={styles.sideLabel}>DOWN</Text>
                  <Text style={styles.sidePrice}>{formatPercent(item.prices.no)}</Text>
                </Pressable>
                <Pressable
                  style={[styles.sideButton, styles.sideUp, isUpSelected && styles.sideButtonSelectedUp]}
                  onPress={() => openStake(item, positiveSelection)}
                >
                  <Text style={styles.sideLabel}>UP</Text>
                  <Text style={styles.sidePrice}>{formatPercent(item.prices.yes)}</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No live stock markets</Text>
            <Text style={styles.emptyText}>Use the Dev tab to generate markets.</Text>
          </View>
        }
      />

      <StakeModal
        visible={modalVisible}
        market={modalMarket}
        selection={modalSelection}
        userId={userId}
        onClose={closeStake}
        onDone={async () => {
          await refresh();
          setActivePick(undefined);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  hero: {
    marginHorizontal: 14,
    marginTop: 10,
    marginBottom: 12,
    borderRadius: layout.radiusLg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 8,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: {
    color: colors.text,
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 0.2,
  },
  liveChip: {
    borderRadius: 999,
    backgroundColor: "rgba(102,188,255,0.2)",
    borderWidth: 1,
    borderColor: "rgba(102,188,255,0.55)",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  liveChipText: {
    color: colors.accentBlue,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  subtitle: {
    color: colors.muted,
    fontWeight: "700",
  },
  metaRow: {
    flexDirection: "row",
    gap: 14,
  },
  meta: {
    color: colors.muted,
    fontWeight: "700",
    fontSize: 12,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 0,
    paddingBottom: 24,
    gap: 12,
  },
  windowCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusLg,
    backgroundColor: colors.card,
    overflow: "hidden",
    padding: 12,
    gap: 10,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  windowQuestion: {
    color: colors.text,
    fontSize: 23,
    fontWeight: "900",
    lineHeight: 29,
    flex: 1,
  },
  livePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(102,188,255,0.6)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.accentGreen,
  },
  liveText: {
    color: colors.accentBlue,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
  },
  sideButton: {
    flex: 1,
    borderRadius: layout.radiusMd,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sideDown: {
    backgroundColor: "rgba(66,30,43,0.86)",
    borderColor: "#b8566f",
  },
  sideUp: {
    backgroundColor: "rgba(24,63,49,0.86)",
    borderColor: "#439f76",
  },
  sideButtonSelectedDown: {
    transform: [{ scale: 1.04 }],
    backgroundColor: "rgba(76,36,49,0.92)",
    borderColor: "#d56c84",
  },
  sideButtonSelectedUp: {
    transform: [{ scale: 1.04 }],
    backgroundColor: "rgba(32,77,60,0.92)",
    borderColor: "#5ccf95",
  },
  sideLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  sidePrice: {
    color: colors.text,
    fontSize: 30,
    fontWeight: "900",
    marginTop: 2,
  },
  emptyWrap: {
    borderRadius: layout.radiusLg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surface,
    marginTop: 10,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
  },
  emptyText: {
    color: colors.muted,
    textAlign: "center",
  },
});
