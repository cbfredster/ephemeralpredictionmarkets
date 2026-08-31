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
import { useStripe } from "@stripe/stripe-react-native";

import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import { colors } from "../theme/tokens";

export function DepositScreen() {
    const { initPaymentSheet, presentPaymentSheet } = useStripe();
    const { userId, wallet, setWallet } = useAppStore();

    const [amount, setAmount] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState<string>();

    const amountEur = parseFloat(amount) || 0;
    const amountCents = Math.round(amountEur * 100);
    const isValid = amountEur >= 0.5; // Stripe minimum

    const onDeposit = async () => {
        if (!userId || !isValid) return;
        setLoading(true);
        setError(undefined);
        setSuccess(undefined);

        try {
            // 1. Create PaymentIntent on the server
            const { clientSecret } = await api.stripeCreatePaymentIntent(userId, amountCents);

            // 2. Initialise the PaymentSheet
            const { error: initError } = await initPaymentSheet({
                merchantDisplayName: "Moment",
                paymentIntentClientSecret: clientSecret,
                defaultBillingDetails: { name: "Moment User" },
                appearance: {
                    colors: {
                        primary: colors.accentBlue,
                        background: colors.surface,
                        componentBackground: colors.bgElevated,
                        componentText: colors.text,
                        primaryText: colors.text,
                        secondaryText: colors.muted,
                        placeholderText: colors.muted,
                        icon: colors.muted,
                        componentBorder: colors.border,
                    },
                },
            });

            if (initError) {
                setError(initError.message);
                return;
            }

            // 3. Present the PaymentSheet
            const { error: paymentError } = await presentPaymentSheet();

            if (paymentError) {
                if (paymentError.code !== "Canceled") {
                    setError(paymentError.message);
                }
                return;
            }

            // 4. Payment confirmed — persist balance on the server
            const result = await api.addFunds(userId, amountEur);
            setWallet(result.wallet);
            setAmount("");
            setSuccess(`Successfully deposited €${amountEur.toFixed(2)}! New balance: €${result.wallet.balance.toFixed(2)}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Deposit failed. Please try again.");
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
                    <Text style={styles.heading}>Deposit</Text>
                    <Text style={styles.subheading}>Add funds to your Moment account</Text>

                    {/* Balance Card */}
                    <View style={styles.balanceCard}>
                        <Text style={styles.balanceLabel}>Current Balance</Text>
                        <Text style={styles.balanceValue}>EUR {wallet?.balance.toFixed(2) ?? "0.00"}</Text>
                    </View>

                    {/* Amount Input */}
                    <View style={styles.inputCard}>
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
                        {amountEur > 0 && amountEur < 0.5 && (
                            <Text style={styles.hint}>Minimum deposit is €0.50</Text>
                        )}
                    </View>

                    {/* Quick amounts */}
                    <View style={styles.quickRow}>
                        {[5, 10, 25, 50].map((q) => (
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
                    </View>

                    {/* Feedback */}
                    {error ? <Text style={styles.error}>{error}</Text> : null}
                    {success ? <Text style={styles.successMsg}>{success}</Text> : null}

                    {/* Deposit Button */}
                    <Pressable
                        style={[styles.depositButton, (!isValid || loading) && styles.buttonDisabled]}
                        onPress={onDeposit}
                        disabled={!isValid || loading}
                    >
                        {loading ? (
                            <ActivityIndicator color={colors.bg} />
                        ) : (
                            <Text style={styles.depositButtonText}>
                                {isValid ? `Deposit €${amountEur.toFixed(2)}` : "Enter an amount"}
                            </Text>
                        )}
                    </Pressable>

                    {/* Test card hint */}
                    <View style={styles.testHint}>
                        <Text style={styles.testHintTitle}>🧪 Test Mode</Text>
                        <Text style={styles.testHintText}>
                            Use card <Text style={styles.testCard}>4242 4242 4242 4242</Text>
                        </Text>
                        <Text style={styles.testHintText}>Any future date · Any 3-digit CVC</Text>
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
    quickRow: {
        flexDirection: "row",
        gap: 8,
    },
    quickChip: {
        flex: 1,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        paddingVertical: 10,
        alignItems: "center",
        backgroundColor: colors.surface,
    },
    quickChipText: {
        color: colors.text,
        fontWeight: "800",
        fontSize: 14,
    },
    depositButton: {
        backgroundColor: colors.accentBlue,
        borderRadius: 14,
        paddingVertical: 16,
        alignItems: "center",
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    depositButtonText: {
        color: colors.bg,
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
        borderColor: "#2a3a20",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#111a0e",
        gap: 4,
        alignItems: "center",
        marginTop: 8,
    },
    testHintTitle: {
        color: colors.accentGreen,
        fontWeight: "800",
        fontSize: 13,
    },
    testHintText: {
        color: colors.muted,
        fontSize: 12,
        fontWeight: "600",
    },
    testCard: {
        color: colors.text,
        fontWeight: "800",
    },
});
