import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";

import { MarketCard } from "../components/MarketCard";
import { StakeModal } from "../components/StakeModal";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import { colors, gradients, layout } from "../theme/tokens";
import type { Market, Selection } from "../types/contracts";

export function F1Screen() {
  const { userId, markets, bets, wallet, setMarkets, setBets, setWallet } = useAppStore();
  const [modalMarketId, setModalMarketId] = useState<string>();
  const [modalSelection, setModalSelection] = useState<Selection>();
  const [modalVisible, setModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activePick, setActivePick] = useState<{ marketId: string; selection: Selection }>();

  const f1Markets = useMemo(
    () => markets.filter((market) => market.sport === "F1"),
    [markets],
  );
  const modalMarket = useMemo(
    () => (modalMarketId ? markets.find((market) => market.market_id === modalMarketId) : undefined),
    [markets, modalMarketId],
  );

  const f1MarketIds = useMemo(() => new Set(f1Markets.map((m) => m.market_id)), [f1Markets]);
  const f1Bets = useMemo(() => bets.filter((bet) => f1MarketIds.has(bet.market_id)).slice(0, 4), [bets, f1MarketIds]);

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
      <LinearGradient colors={gradients.heroSports} style={styles.hero}>
        <View style={styles.heroTop}>
          <Text style={styles.title}>Sports</Text>
          <View style={styles.liveChip}>
            <Text style={styles.liveChipText}>LIVE FEED</Text>
          </View>
        </View>
        <Text style={styles.subtitle}>Live F1 markets from backend</Text>
        <View style={styles.metaRow}>
          <Text style={styles.meta}>Wallet €{wallet?.balance.toFixed(2) ?? "--"}</Text>
          <Text style={styles.meta}>{f1Bets.length} active picks</Text>
        </View>
      </LinearGradient>

      <FlatList
        data={f1Markets}
        keyExtractor={(item) => item.market_id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accentBlue} />}
        renderItem={({ item }) => (
          <MarketCard
            market={item}
            onPick={openStake}
            variant="f1"
            positiveOnRight
            selectedSelection={activePick?.marketId === item.market_id ? activePick.selection : undefined}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No live F1 markets</Text>
            <Text style={styles.emptyText}>Pull to refresh.</Text>
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
    backgroundColor: "rgba(88,182,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(88,182,255,0.45)",
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
    gap: 12,
    paddingBottom: 24,
  },
  emptyWrap: {
    borderRadius: layout.radiusLg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surface,
    marginTop: 20,
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
