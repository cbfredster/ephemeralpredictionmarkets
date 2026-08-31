import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import { colors, gradients, layout } from "../theme/tokens";
import type { Market, Selection } from "../types/contracts";

type Props = {
  market: Market;
  onPick: (market: Market, selection: Selection) => void;
  leftLabel?: string;
  rightLabel?: string;
  variant?: "f1" | "stocks";
  compact?: boolean;
  showSportTag?: boolean;
  positiveOnRight?: boolean;
  selectedSelection?: Selection;
};

const isPositiveSelection = (selection: Selection): boolean =>
  selection === "YES" || selection === "HIGHER";

const formatPercent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const sideCopy = (
  type: Market["market_type"],
  leftLabel?: string,
  rightLabel?: string,
  positiveOnRight = false,
) => {
  const base =
    type === "binary_higher_lower"
      ? {
          positiveLabel: "HIGHER",
          negativeLabel: "LOWER",
          positiveSelection: "HIGHER" as const,
          negativeSelection: "LOWER" as const,
        }
      : {
          positiveLabel: "YES",
          negativeLabel: "NO",
          positiveSelection: "YES" as const,
          negativeSelection: "NO" as const,
        };

  if (positiveOnRight) {
    return {
      left: leftLabel ?? base.negativeLabel,
      right: rightLabel ?? base.positiveLabel,
      leftSelection: base.negativeSelection,
      rightSelection: base.positiveSelection,
    };
  }

  return {
    left: leftLabel ?? base.positiveLabel,
    right: rightLabel ?? base.negativeLabel,
    leftSelection: base.positiveSelection,
    rightSelection: base.negativeSelection,
  };
};

const statusTone = (status: Market["status"]) => {
  if (status === "open") return { bg: "rgba(57,204,134,0.15)", text: colors.accentGreen };
  if (status === "closed") return { bg: "rgba(255,183,101,0.16)", text: colors.accentOrange };
  if (status === "settled") return { bg: "rgba(88,182,255,0.18)", text: colors.accentBlue };
  return { bg: "rgba(255,100,127,0.16)", text: colors.bad };
};

export function MarketCard({
  market,
  onPick,
  leftLabel,
  rightLabel,
  variant = "f1",
  compact = false,
  showSportTag = true,
  positiveOnRight = false,
  selectedSelection,
}: Props) {
  const copy = sideCopy(market.market_type, leftLabel, rightLabel, positiveOnRight);
  const freshnessMs = Date.now() - market.timestamps.updated_at_ms;
  const isOpen = market.status === "open";
  const liveLabel = isOpen ? (freshnessMs < 4_000 ? "LIVE" : freshnessMs < 15_000 ? "ACTIVE" : "") : "";
  const liveColor = freshnessMs < 4_000 ? colors.accentGreen : freshnessMs < 15_000 ? colors.accentBlue : colors.muted;
  const prevYesRef = useRef(market.prices.yes);
  const [trend, setTrend] = useState<"up" | "down" | "flat">("flat");

  useEffect(() => {
    if (market.prices.yes > prevYesRef.current) setTrend("up");
    if (market.prices.yes < prevYesRef.current) setTrend("down");
    if (market.prices.yes === prevYesRef.current) setTrend("flat");
    prevYesRef.current = market.prices.yes;
  }, [market.prices.yes]);

  const gradient = useMemo(
    () => (variant === "stocks" ? gradients.cardStocks : gradients.cardSports),
    [variant],
  );

  const tone = statusTone(market.status);
  const trendText = trend === "up" ? "MOMENTUM UP" : trend === "down" ? "MOMENTUM DOWN" : "MOMENTUM FLAT";
  const leftSelected = selectedSelection === copy.leftSelection;
  const rightSelected = selectedSelection === copy.rightSelection;
  const leftPositive = isPositiveSelection(copy.leftSelection);
  const rightPositive = isPositiveSelection(copy.rightSelection);
  const leftPrice = leftPositive ? market.prices.yes : market.prices.no;
  const rightPrice = rightPositive ? market.prices.yes : market.prices.no;

  return (
    <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
      <View style={styles.topRow}>
        <View style={styles.tagsRow}>
          {showSportTag ? (
            <View style={styles.tag}>
              <Text style={styles.tagText}>{market.sport}</Text>
            </View>
          ) : null}
          <View style={[styles.tag, { backgroundColor: tone.bg }]}>
            <Text style={[styles.tagText, { color: tone.text }]}>{market.status.toUpperCase()}</Text>
          </View>
        </View>
        {liveLabel ? (
          <View style={styles.liveWrap}>
            <View style={[styles.pulse, { backgroundColor: liveColor }]} />
            <Text style={[styles.liveText, { color: liveColor }]}>{liveLabel}</Text>
          </View>
        ) : null}
      </View>

      <Text style={[styles.question, compact && styles.questionCompact]}>{market.question}</Text>

      <View style={styles.metaRow}>
        <Text style={styles.metaText}>{trendText}</Text>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={[
            styles.sideBtn,
            leftPositive ? styles.sidePositive : styles.sideNegative,
            compact && styles.sideBtnCompact,
            leftSelected && styles.sideBtnSelected,
            leftSelected && (leftPositive ? styles.sideBtnSelectedPositive : styles.sideBtnSelectedNegative),
          ]}
          onPress={() => onPick(market, copy.leftSelection)}
        >
          <Text style={styles.sideLabel}>{copy.left}</Text>
          <Text style={[styles.sidePrice, compact && styles.sidePriceCompact]}>{formatPercent(leftPrice)}</Text>
        </Pressable>

        <Pressable
          style={[
            styles.sideBtn,
            rightPositive ? styles.sidePositive : styles.sideNegative,
            compact && styles.sideBtnCompact,
            rightSelected && styles.sideBtnSelected,
            rightSelected && (rightPositive ? styles.sideBtnSelectedPositive : styles.sideBtnSelectedNegative),
          ]}
          onPress={() => onPick(market, copy.rightSelection)}
        >
          <Text style={styles.sideLabel}>{copy.right}</Text>
          <Text style={[styles.sidePrice, compact && styles.sidePriceCompact]}>{formatPercent(rightPrice)}</Text>
        </Pressable>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusLg,
    padding: 16,
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tagsRow: {
    flexDirection: "row",
    gap: 8,
  },
  tag: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  liveWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pulse: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  liveText: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  question: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 30,
  },
  questionCompact: {
    fontSize: 18,
    lineHeight: 24,
  },
  metaRow: {
    flexDirection: "row",
  },
  metaText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
  },
  sideBtn: {
    flex: 1,
    borderRadius: layout.radiusMd,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sideBtnCompact: {
    paddingVertical: 8,
  },
  sideBtnSelected: {
    transform: [{ scale: 1.04 }],
  },
  sideBtnSelectedPositive: {
    borderColor: "#5ccf95",
    backgroundColor: "rgba(32,77,60,0.92)",
  },
  sideBtnSelectedNegative: {
    borderColor: "#d56c84",
    backgroundColor: "rgba(76,36,49,0.92)",
  },
  sidePositive: {
    backgroundColor: "rgba(24,63,49,0.86)",
    borderColor: "#439f76",
  },
  sideNegative: {
    backgroundColor: "rgba(66,30,43,0.86)",
    borderColor: "#b8566f",
  },
  sideLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  sidePrice: {
    color: colors.text,
    fontSize: 30,
    fontWeight: "900",
    marginTop: 2,
  },
  sidePriceCompact: {
    fontSize: 24,
  },
});
