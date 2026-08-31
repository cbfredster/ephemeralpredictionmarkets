import { useState } from "react";
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import { colors } from "../theme/tokens";

export function WithdrawScreen() {
    const { userId, wallet, setWallet } = useAppStore();

    const [amount, setAmount] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState<string>();

    const balance = wallet?.balance ?? 0;
    const amountEur = parseFloat(amount) || 0;
    const amountCents = Math.round(amountEur * 100);

    const insufficientFunds = amountEur > 0 && amountEur > balance;
    const belowMin = amountEur > 0 && amountEur < 0.5;
    const isValid = amountEur >= 0.5 && amountEur <= balance;

    const onWithdraw = async () => {
        if (!userId || !isValid) return;
        setLoading(true);
        setError(undefined);
        setSuccess(undefined);

        try {
            const result = await api.stripeCreatePayout(userId, amountCents);
            setWallet(result.wallet);
            setAmount("");
            setSuccess(
                `Withdrawal of €${amountEur.toFixed(2)} processed. Remaining balance: €${result.wallet.balance.toFixed(2)}`,
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : "Withdrawal failed. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === "ios" ? "padding" : "height"}
            >
                <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                    <Text style={styles.heading}>Withdraw</Text>
                    <Text style={styles.subheading}>Withdraw funds from your Moment account</Text>

                    {/* Balance Card */}
                    <View style={styles.balanceCard}>
                        <Text style={styles.balanceLabel}>Available Balance</Text>
                        <Text style={styles.balanceValue}>EUR {balance.toFixed(2)}</Text>
                    </View>

                    {/* Amount Input */}
                    <View style={[styles.inputCard, insufficientFunds && styles.inputCardError]}>
                        <Text style={styles.cardTitle}>Amount</Text>
                        <View style={styles.inputRow}>
                            <Text style={styles.currencySymbol}>€</Text>
                            <TextInput
                                style={styles.input}
                                placeholder="0.00"
                                placeholderTextColor={colors.muted}
                                keyboardType="decimal-pad"
                                value={amount}
                                onChangeText={(v) => {
                                    setError(undefined);
                                    setSuccess(undefined);
                                    setAmount(v);
                                }}
                                editable={!loading}
                                returnKeyType="done"
                            />
                        </View>
                        {belowMin && <Text style={styles.hint}>Minimum withdrawal is €0.50</Text>}
                        {insufficientFunds && (
                            <Text style={styles.hintError}>
                                Insufficient balance — you only have €{balance.toFixed(2)}
                            </Text>
                        )}
                    </View>

                    {/* Quick amounts — only show values ≤ balance */}
                    {balance >= 0.5 && (
                        <View style={styles.quickRow}>
                            {[5, 10, 25, 50]
                                .filter((q) => q <= balance)
                                .map((q) => (
                                    <Pressable
                                        key={q}
                                        style={styles.quickChip}
                                        onPress={() => {
                                            setError(undefined);
                                            setSuccess(undefined);
                                            setAmount(q.toString());
                                        }}
                                    >
                                        <Text style={styles.quickChipText}>€{q}</Text>
                                    </Pressable>
                                ))}
                            {/* "All" chip */}
                            <Pressable
                                style={[styles.quickChip, styles.quickChipAll]}
                                onPress={() => {
                                    setError(undefined);
                                    setSuccess(undefined);
                                    setAmount(balance.toFixed(2));
                                }}
                            >
                                <Text style={styles.quickChipText}>All</Text>
                            </Pressable>
                        </View>
                    )}

                    {/* Feedback */}
                    {error ? <Text style={styles.error}>{error}</Text> : null}
                    {success ? <Text style={styles.successMsg}>{success}</Text> : null}

                    {/* Withdraw Button */}
                    <Pressable
                        style={[styles.withdrawButton, (!isValid || loading) && styles.buttonDisabled]}
                        onPress={onWithdraw}
                        disabled={!isValid || loading}
                    >
                        {loading ? (
                            <ActivityIndicator color={colors.text} />
                        ) : (
                            <Text style={styles.withdrawButtonText}>
                                {insufficientFunds
                                    ? "Insufficient balance"
                                    : isValid
                                        ? `Withdraw €${amountEur.toFixed(2)}`
                                        : "Enter an amount"}
                            </Text>
                        )}
                    </Pressable>

                    {/* Test mode note */}
                    <View style={styles.testHint}>
                        <Text style={styles.testHintTitle}>🧪 Test Mode</Text>
                        <Text style={styles.testHintText}>
                            Withdrawal is simulated — no real bank transfer occurs in test mode.
                        </Text>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg,
    },
    content: {
        padding: 16,
        gap: 14,
    },
    heading: {
        color: colors.text,
        fontSize: 38,
        fontWeight: "900",
        letterSpacing: 0.2,
    },
    subheading: {
        color: colors.muted,
        fontSize: 14,
        fontWeight: "600",
        marginTop: -8,
    },
    balanceCard: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 16,
        padding: 14,
        backgroundColor: colors.surface,
        gap: 4,
    },
    balanceLabel: {
        color: colors.muted,
        fontSize: 12,
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: 0.5,
    },
    balanceValue: {
        color: colors.text,
        fontSize: 30,
        fontWeight: "900",
    },
    inputCard: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 16,
        padding: 14,
        backgroundColor: colors.surface,
        gap: 10,
    },
    inputCardError: {
        borderColor: colors.bad,
    },
    cardTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: "800",
    },
    inputRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
    },
    currencySymbol: {
        color: colors.muted,
        fontSize: 26,
        fontWeight: "700",
    },
    input: {
        flex: 1,
        color: colors.text,
        fontSize: 32,
        fontWeight: "900",
        paddingVertical: 4,
    },
    hint: {
        color: colors.accentOrange,
        fontSize: 12,
        fontWeight: "600",
    },
    hintError: {
        color: colors.bad,
        fontSize: 12,
        fontWeight: "700",
    },
    quickRow: {
        flexDirection: "row",
        gap: 8,
        flexWrap: "wrap",
    },
    quickChip: {
        flex: 1,
        minWidth: 60,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        paddingVertical: 10,
        alignItems: "center",
        backgroundColor: colors.surface,
    },
    quickChipAll: {
        borderColor: "#c26d83",
        backgroundColor: "#4a2330",
    },
    quickChipText: {
        color: colors.text,
        fontWeight: "800",
        fontSize: 14,
    },
    withdrawButton: {
        backgroundColor: "#4a2330",
        borderWidth: 1,
        borderColor: "#c26d83",
        borderRadius: 14,
        paddingVertical: 16,
        alignItems: "center",
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    withdrawButtonText: {
        color: colors.text,
        fontWeight: "900",
        fontSize: 17,
    },
    error: {
        color: colors.bad,
        fontSize: 13,
        fontWeight: "600",
        textAlign: "center",
    },
    successMsg: {
        color: colors.good,
        fontSize: 13,
        fontWeight: "700",
        textAlign: "center",
    },
    testHint: {
        borderWidth: 1,
        borderColor: "#2a2a1a",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#1a1a0e",
        gap: 4,
        alignItems: "center",
        marginTop: 8,
    },
    testHintTitle: {
        color: colors.accentOrange,
        fontWeight: "800",
        fontSize: 13,
    },
    testHintText: {
        color: colors.muted,
        fontSize: 12,
        fontWeight: "600",
        textAlign: "center",
    },
});
