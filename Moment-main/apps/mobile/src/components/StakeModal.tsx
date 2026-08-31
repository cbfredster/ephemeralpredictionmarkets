import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { api } from "../services/api";
import { colors, layout } from "../theme/tokens";
import type { BetQuote, Market, Selection } from "../types/contracts";

type Props = {
  visible: boolean;
  market?: Market;
  selection?: Selection;
  userId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
};

const PRESETS = [1, 5, 10] as const;

export function StakeModal({ visible, market, selection, userId, onClose, onDone }: Props) {
  const [amountInput, setAmountInput] = useState("1");
  const [selectedPreset, setSelectedPreset] = useState<number | null>(1);
  const [submitState, setSubmitState] = useState<"idle" | "pending" | "rejected">("idle");
  const [submitError, setSubmitError] = useState<string>();
  const [quote, setQuote] = useState<BetQuote>();
  const [quoteState, setQuoteState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [quoteError, setQuoteError] = useState<string>();
  const amount = useMemo(() => Number(amountInput), [amountInput]);
  const canQuote = Boolean(visible && market && selection && Number.isFinite(amount) && amount > 0);

  useEffect(() => {
    if (!visible) return;
    setAmountInput("1");
    setSelectedPreset(1);
    setSubmitError(undefined);
    setQuote(undefined);
    setQuoteState("idle");
    setQuoteError(undefined);
    setSubmitState("idle");
  }, [visible]);

  const fetchQuote = useCallback(async (): Promise<BetQuote | undefined> => {
    if (!market || !selection || !Number.isFinite(amount) || amount <= 0) return undefined;
    setQuoteState((prev) => (prev === "ready" ? "ready" : "loading"));
    try {
      const next = await api.quote({
        user_id: userId,
        market_id: market.market_id,
        selection,
        stake: amount,
      });
      setQuote(next);
      setQuoteState("ready");
      setQuoteError(undefined);
      return next;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Quote unavailable";
      setQuote(undefined);
      setQuoteState("error");
      setQuoteError(message);
      return undefined;
    }
  }, [amount, market, selection, userId]);

  useEffect(() => {
    if (!canQuote) {
      setQuote(undefined);
      setQuoteState("idle");
      setQuoteError(undefined);
      return;
    }

    void fetchQuote();
  }, [canQuote, fetchQuote, market?.timestamps.updated_at_ms]);

  useEffect(() => {
    if (!canQuote) return;
    const timer = setInterval(() => {
      void fetchQuote();
    }, 2_500);
    return () => clearInterval(timer);
  }, [canQuote, fetchQuote]);

  const onSelectPreset = (preset: number) => {
    setSelectedPreset(preset);
    setAmountInput(String(preset));
    setSubmitError(undefined);
  };

  const onChangeCustomAmount = (next: string) => {
    setAmountInput(next);
    const n = Number(next);
    setSelectedPreset(PRESETS.includes(n as (typeof PRESETS)[number]) ? n : null);
    setSubmitError(undefined);
  };

  const onConfirm = async () => {
    if (!market || !selection) return;
    if (!Number.isFinite(amount) || amount <= 0) {
      setSubmitError("Enter a valid amount");
      return;
    }

    setSubmitState("pending");
    setSubmitError(undefined);
    if (!quote) {
      await fetchQuote();
    }

    try {
      await api.placeBet({ user_id: userId, market_id: market.market_id, selection, stake: amount });
      await onDone();
      onClose();
    } catch (e) {
      setSubmitState("rejected");
      setSubmitError(e instanceof Error ? e.message : "Pick failed");
    }
  };

  const actionLabel =
    submitState === "pending"
      ? "Placing..."
      : submitState === "rejected"
        ? "Retry"
        : quote
          ? `Confirm €${quote.potential_payout.toFixed(2)}`
          : "Confirm";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Pick {selection ?? ""}</Text>

          <View style={styles.row}>
            {PRESETS.map((preset) => (
              <Pressable
                key={preset}
                style={[styles.preset, selectedPreset === preset && styles.presetSelected]}
                onPress={() => onSelectPreset(preset)}
              >
                <Text style={styles.presetText}>€{preset}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.amountWrap}>
            <Text style={styles.amountLabel}>Custom</Text>
            <View style={styles.amountRow}>
              <Text style={styles.euro}>€</Text>
              <TextInput
                value={amountInput}
                onChangeText={onChangeCustomAmount}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={colors.muted}
                style={styles.amountInput}
              />
            </View>
          </View>

          <View style={styles.quoteWrap}>
            <Text style={styles.quoteTitle}>Live Quote</Text>
            {quoteState === "loading" && !quote ? (
              <View style={styles.quoteLoading}>
                <ActivityIndicator color={colors.accentBlue} size="small" />
                <Text style={styles.quoteMuted}>Fetching latest price...</Text>
              </View>
            ) : null}
            {quote ? (
              <>
                <View style={styles.quoteRow}>
                  <Text style={styles.quoteLabel}>Current price</Text>
                  <Text style={styles.quoteValue}>{(quote.estimated_price * 100).toFixed(1)}%</Text>
                </View>
                <View style={styles.quoteRow}>
                  <Text style={styles.quoteLabel}>After your pick</Text>
                  <Text style={styles.quoteValue}>{(quote.estimated_price_after * 100).toFixed(1)}%</Text>
                </View>
                <View style={styles.quoteRow}>
                  <Text style={styles.quoteLabel}>Potential payout</Text>
                  <Text style={styles.quotePayout}>€{quote.potential_payout.toFixed(2)}</Text>
                </View>
              </>
            ) : null}
            {quoteError ? <Text style={styles.error}>{quoteError}</Text> : null}
          </View>
          {submitError ? <Text style={styles.error}>{submitError}</Text> : null}

          <View style={styles.row}>
            <Pressable style={[styles.action, styles.cancel]} onPress={onClose}>
              <Text style={styles.actionText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.action, styles.confirm]}
              onPress={onConfirm}
              disabled={submitState === "pending"}
            >
              <Text style={styles.actionText}>{actionLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 12,
    backgroundColor: "rgba(3,7,13,0.75)",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: layout.radiusLg,
    borderWidth: 1,
    borderColor: colors.border,
    width: "100%",
    maxWidth: 480,
    padding: 14,
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "900",
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  preset: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusSm,
    backgroundColor: colors.bgElevated,
    paddingVertical: 10,
    alignItems: "center",
  },
  presetSelected: {
    borderColor: colors.accentBlue,
    backgroundColor: "#17304a",
  },
  presetText: {
    color: colors.text,
    fontWeight: "800",
  },
  amountWrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusMd,
    padding: 10,
    gap: 6,
    backgroundColor: colors.bgElevated,
  },
  amountLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  euro: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
  },
  amountInput: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
    paddingVertical: 0,
    flex: 1,
  },
  error: {
    color: colors.bad,
    fontSize: 12,
    fontWeight: "700",
  },
  quoteWrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusMd,
    backgroundColor: colors.bgElevated,
    padding: 10,
    gap: 8,
  },
  quoteTitle: {
    color: colors.text,
    fontWeight: "800",
    fontSize: 12,
    letterSpacing: 0.2,
  },
  quoteLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  quoteMuted: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  quoteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  quoteLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  quoteValue: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  quotePayout: {
    color: colors.accentGreen,
    fontSize: 14,
    fontWeight: "900",
  },
  action: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: layout.radiusSm,
    alignItems: "center",
  },
  cancel: {
    backgroundColor: "#1d2a3f",
  },
  confirm: {
    backgroundColor: "#1f5f8f",
  },
  actionText: {
    color: "#fff",
    fontWeight: "800",
  },
});
