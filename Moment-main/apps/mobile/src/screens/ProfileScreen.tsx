import { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
    Easing,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { useStripe } from "@stripe/stripe-react-native";

import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import { colors } from "../theme/tokens";
import type { Bet } from "../types/contracts";

// ─── Apple Pay-style success sheet ───────────────────────────────────────────

const RING_RADIUS = 38;
const RING_C = 2 * Math.PI * RING_RADIUS;
const CHECK_LEN = 65;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

function ApplePaySheet({
    visible,
    title,
    onDone,
}: {
    visible: boolean;
    title: string;
    onDone: () => void;
}) {
    const backdrop = useRef(new Animated.Value(0)).current;
    const sheetY = useRef(new Animated.Value(380)).current;
    const ring = useRef(new Animated.Value(RING_C)).current;
    const check = useRef(new Animated.Value(CHECK_LEN)).current;
    const btnOp = useRef(new Animated.Value(0)).current;
    const [active, setActive] = useState(false);

    useEffect(() => {
        if (!visible) return;
        setActive(true);
        backdrop.setValue(0);
        sheetY.setValue(380);
        ring.setValue(RING_C);
        check.setValue(CHECK_LEN);
        btnOp.setValue(0);
        Animated.sequence([
            Animated.parallel([
                Animated.timing(backdrop, { toValue: 1, duration: 200, useNativeDriver: true }),
                Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 14 }),
            ]),
            Animated.timing(ring, { toValue: 0, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
            Animated.timing(check, { toValue: 0, duration: 420, easing: Easing.out(Easing.quad), useNativeDriver: false }),
            Animated.timing(btnOp, { toValue: 1, duration: 200, useNativeDriver: true }),
        ]).start();
    }, [visible, backdrop, sheetY, ring, check, btnOp]);

    const done = () =>
        Animated.parallel([
            Animated.timing(sheetY, { toValue: 500, duration: 440, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
            Animated.timing(backdrop, { toValue: 0, duration: 320, useNativeDriver: true }),
        ]).start(() => { setActive(false); onDone(); });

    if (!active && !visible) return null;
    return (
        <Animated.View style={[styles.apBackdrop, { opacity: backdrop }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={done} />
            <Animated.View style={[styles.apSheet, { transform: [{ translateY: sheetY }] }]}>
                <View style={styles.apHandle} />
                <Svg width={96} height={96} viewBox="0 0 96 96">
                    <Circle cx={48} cy={48} r={RING_RADIUS} stroke="#1c2b1c" strokeWidth={2.5} fill="none" />
                    <AnimatedCircle
                        cx={48} cy={48} r={RING_RADIUS} stroke={colors.good} strokeWidth={2} fill="none"
                        strokeDasharray={RING_C} strokeDashoffset={ring}
                        strokeLinecap="round" rotation={-90} origin="48,48"
                    />
                    <AnimatedPath
                        d="M 27 49 L 42 64 L 69 36" stroke={colors.good} strokeWidth={2.2} fill="none"
                        strokeLinecap="round" strokeLinejoin="round"
                        strokeDasharray={CHECK_LEN} strokeDashoffset={check}
                    />
                </Svg>
                <Text style={styles.apTitle}>{title}</Text>
                <Animated.View style={{ opacity: btnOp, width: "100%" }}>
                    <Pressable style={styles.apDoneBtn} onPress={done}>
                        <Text style={styles.apDoneBtnText}>Done</Text>
                    </Pressable>
                </Animated.View>
            </Animated.View>
        </Animated.View>
    );
}

// ─── Odometer digit ───────────────────────────────────────────────────────────

function OdometerChar({ char, color, isUp }: { char: string; color: string; isUp: boolean }) {
    const slide = useRef(new Animated.Value(0)).current;
    const prev = useRef(char);

    useEffect(() => {
        if (char === prev.current) return;
        prev.current = char;
        if (!/\d/.test(char)) return;
        slide.setValue(isUp ? 18 : -18);
        Animated.timing(slide, {
            toValue: 0,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        }).start();
    }, [char, isUp, slide]);

    return (
        <Animated.Text style={[styles.odometerChar, { color, transform: [{ translateY: slide }] }]}>
            {char}
        </Animated.Text>
    );
}

// ─── Animated balance (odometer) ─────────────────────────────────────────────

function AnimatedBalance({ balance }: { balance: number }) {
    const animVal = useRef(new Animated.Value(balance)).current;
    const prev = useRef(balance);
    const [display, setDisplay] = useState(balance);
    const [color, setColor] = useState<string>(colors.text);
    const [isUp, setIsUp] = useState(true);

    useEffect(() => {
        const p = prev.current;
        if (p === balance) return;
        const up = balance > p;
        setIsUp(up);
        setColor(up ? colors.good : colors.bad);
        animVal.setValue(p);
        const lis = animVal.addListener(({ value }) => setDisplay(value));
        Animated.timing(animVal, {
            toValue: balance,
            duration: up ? 2200 : 3800,
            easing: up ? Easing.out(Easing.exp) : Easing.inOut(Easing.back(1.4)),
            useNativeDriver: false,
        }).start(() => {
            animVal.removeListener(lis);
            setDisplay(balance);
            setColor(colors.text);
        });
        prev.current = balance;
    }, [balance, animVal]);

    const numStr = display.toFixed(2);
    const [intPart, decPart] = numStr.split(".");

    return (
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
            <Text style={[styles.odometerPrefix, { color }]}>EUR </Text>
            {intPart.split("").map((c, i) => (
                <OdometerChar key={`i${i}`} char={c} color={color} isUp={isUp} />
            ))}
            <Text style={[styles.odometerChar, { color }]}>.</Text>
            {decPart.split("").map((c, i) => (
                <OdometerChar key={`d${i}`} char={c} color={color} isUp={isUp} />
            ))}
        </View>
    );
}

// ─── Deposit Modal ────────────────────────────────────────────────────────────

function DepositModal({
    visible,
    onClose,
    onSuccess,
}: {
    visible: boolean;
    onClose: () => void;
    onSuccess: (t: string, amount: number, type: "deposit" | "withdrawal") => void;
}) {
    const { initPaymentSheet, presentPaymentSheet } = useStripe();
    const { userId, wallet, setWallet } = useAppStore();
    const [amount, setAmount] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const dimAnim = useRef(new Animated.Value(0)).current;
    const amountInputRef = useRef<TextInput>(null);
    const lastValidAmount = useRef("");

    const showDim = () => Animated.timing(dimAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    const hideDim = () => Animated.timing(dimAnim, { toValue: 0, duration: 280, useNativeDriver: true }).start();

    const amountEur = parseFloat(amount) || 0;
    const amountCents = Math.round(amountEur * 100);
    const isValid = amountEur >= 0.5;

    const reset = () => { setAmount(""); setError(undefined); };
    const handleClose = () => { reset(); onClose(); };

    const onDeposit = async () => {
        if (!userId || !isValid) return;
        Keyboard.dismiss();
        setLoading(true);
        setError(undefined);
        try {
            const { clientSecret } = await api.stripeCreatePaymentIntent(userId, amountCents);
            const { error: ie } = await initPaymentSheet({
                merchantDisplayName: "Moment",
                paymentIntentClientSecret: clientSecret,
                returnURL: "moment://stripe-redirect",
                defaultBillingDetails: { name: "Moment User" },
                appearance: {
                    colors: {
                        primary: "#635BFF",
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
            if (ie) { setError(ie.message); return; }
            Keyboard.dismiss();
            showDim();
            const { error: pe } = await presentPaymentSheet();
            hideDim();
            if (pe) { if (pe.code !== "Canceled") setError(pe.message); return; }
            const result = await api.addFunds(userId, amountEur);
            setWallet(result.wallet);
            reset();
            onClose();
            onSuccess("Deposit Complete", amountEur, "deposit");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Deposit failed.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
            <View style={styles.overlay}>
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                <View style={styles.modalSheet}>
                    <View style={styles.dragHandle} />
                    <KeyboardAvoidingView
                        style={{ flex: 1 }}
                        behavior={Platform.OS === "ios" ? "padding" : "height"}
                    >
                        <ScrollView
                            style={{ flex: 1 }}
                            contentContainerStyle={styles.sheetContent}
                            keyboardShouldPersistTaps="handled"
                        >
                            <View style={styles.sheetHeader}>
                                <Text style={styles.sheetTitle}>Add Funds</Text>
                                <Pressable onPress={handleClose} style={styles.closeBtn}>
                                    <Text style={styles.closeBtnText}>✕</Text>
                                </Pressable>
                            </View>

                            <View style={styles.balanceCard}>
                                <Text style={styles.balLabel}>Current Balance</Text>
                                <Text style={[styles.balValue, { color: "#58dbad" }]}>
                                    EUR {wallet?.balance.toFixed(2) ?? "0.00"}
                                </Text>
                            </View>

                            <View style={styles.inputCard}>
                                <Text style={styles.cardTitle}>Amount</Text>
                                <View style={styles.inputRow}>
                                    <Text style={styles.currSym}>€</Text>
                                    <TextInput
                                        ref={amountInputRef}
                                        style={styles.amountInput}
                                        placeholder="0.00"
                                        placeholderTextColor={colors.muted}
                                        keyboardType="decimal-pad"
                                        value={amount}
                                        onChangeText={(v) => {
                                            const clean = v.replace(/[^0-9.]/g, "");
                                            const parts = clean.split(".");
                                            if (parts.length > 1 && parts[1].length > 2) {
                                                // Hard-reject: restore previous valid value with no re-render flash
                                                amountInputRef.current?.setNativeProps({ text: lastValidAmount.current });
                                                return;
                                            }
                                            lastValidAmount.current = clean;
                                            setError(undefined);
                                            setAmount(clean);
                                        }}
                                        returnKeyType="done"
                                        blurOnSubmit
                                    />
                                </View>
                            </View>

                            <View style={styles.quickRow}>
                                {[5, 10, 25, 50].map((q) => (
                                    <Pressable
                                        key={q}
                                        style={styles.quickChip}
                                        onPress={() => {
                                            setError(undefined);
                                            setAmount(q.toString());
                                            Keyboard.dismiss();
                                        }}
                                    >
                                        <Text style={styles.quickChipText}>€{q}</Text>
                                    </Pressable>
                                ))}
                            </View>

                            {error ? <Text style={styles.errorText}>{error}</Text> : null}

                            <Pressable
                                style={[
                                    styles.actionBtn,
                                    styles.stripeBtn,
                                    (!isValid || loading) && styles.btnDisabled,
                                ]}
                                onPress={onDeposit}
                                disabled={!isValid || loading}
                            >
                                {loading ? (
                                    <ActivityIndicator color="#fff" />
                                ) : (
                                    <Text style={styles.actionBtnText}>
                                        Deposit via Stripe{isValid ? ` — €${amountEur.toFixed(2)}` : ""}
                                    </Text>
                                )}
                            </Pressable>
                        </ScrollView>
                    </KeyboardAvoidingView>
                </View>
                {/* Dark scrim that appears while Stripe PaymentSheet is open */}
                <Animated.View
                    pointerEvents="none"
                    style={[
                        StyleSheet.absoluteFill,
                        { borderRadius: 24, backgroundColor: "rgba(0,0,0,0.55)", opacity: dimAnim },
                    ]}
                />
            </View>
        </Modal>
    );
}

// ─── Withdraw Modal ───────────────────────────────────────────────────────────

function WithdrawModal({
    visible,
    onClose,
    onSuccess,
}: {
    visible: boolean;
    onClose: () => void;
    onSuccess: (t: string, amount: number, type: "deposit" | "withdrawal") => void;
}) {
    const { userId, wallet, setWallet } = useAppStore();
    const [amount, setAmount] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const amountInputRef = useRef<TextInput>(null);
    const lastValidAmount = useRef("");

    const balance = wallet?.balance ?? 0;
    const amountEur = parseFloat(amount) || 0;
    const amountCents = Math.round(amountEur * 100);
    const insufficient = amountEur > 0 && amountEur > balance;
    const belowMin = amountEur > 0 && amountEur < 0.5;
    const isValid = amountEur >= 0.5 && amountEur <= balance;

    const reset = () => { setAmount(""); setError(undefined); };
    const handleClose = () => { reset(); onClose(); };

    const onWithdraw = async () => {
        if (!userId || !isValid) return;
        Keyboard.dismiss();
        setLoading(true);
        setError(undefined);
        try {
            const result = await api.stripeCreatePayout(userId, amountCents);
            setWallet(result.wallet);
            reset();
            onClose();
            onSuccess("Withdrawal Complete", amountEur, "withdrawal");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Withdrawal failed.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
            <View style={styles.overlay}>
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                <View style={styles.modalSheet}>
                    <View style={styles.dragHandle} />
                    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
                        <ScrollView
                            style={{ flex: 1 }}
                            contentContainerStyle={styles.sheetContent}
                            keyboardShouldPersistTaps="handled"
                        >
                            <View style={styles.sheetHeader}>
                                <Text style={styles.sheetTitle}>Withdraw Funds</Text>
                                <Pressable onPress={handleClose} style={styles.closeBtn}>
                                    <Text style={styles.closeBtnText}>✕</Text>
                                </Pressable>
                            </View>

                            <View style={styles.balanceCard}>
                                <Text style={styles.balLabel}>Available Balance</Text>
                                <Text style={[styles.balValue, { color: "#e87a8a" }]}>EUR {balance.toFixed(2)}</Text>
                            </View>

                            <View style={[styles.inputCard, insufficient && { borderColor: colors.bad }]}>
                                <Text style={styles.cardTitle}>Amount</Text>
                                <View style={styles.inputRow}>
                                    <Text style={styles.currSym}>€</Text>
                                    <TextInput
                                        style={styles.amountInput}
                                        placeholder="0.00"
                                        placeholderTextColor={colors.muted}
                                        keyboardType="decimal-pad"
                                        ref={amountInputRef}
                                        value={amount}
                                        onChangeText={(v) => {
                                            const clean = v.replace(/[^0-9.]/g, "");
                                            const parts = clean.split(".");
                                            if (parts.length > 1 && parts[1].length > 2) {
                                                amountInputRef.current?.setNativeProps({ text: lastValidAmount.current });
                                                return;
                                            }
                                            lastValidAmount.current = clean;
                                            setError(undefined);
                                            setAmount(clean);
                                        }}
                                        editable={!loading}
                                        returnKeyType="done"
                                        blurOnSubmit
                                    />
                                </View>
                                {belowMin && (
                                    <Text style={styles.hint}>Minimum withdrawal is €0.50</Text>
                                )}
                                {insufficient && (
                                    <Text style={[styles.hint, { color: colors.bad }]}>
                                        You only have €{balance.toFixed(2)}
                                    </Text>
                                )}
                            </View>

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
                                                    setAmount(q.toString());
                                                    Keyboard.dismiss();
                                                }}
                                            >
                                                <Text style={styles.quickChipText}>€{q}</Text>
                                            </Pressable>
                                        ))}
                                    <Pressable
                                        style={[styles.quickChip, { borderColor: "#c26d83", backgroundColor: "#4a2330" }]}
                                        onPress={() => {
                                            setError(undefined);
                                            setAmount(balance.toFixed(2));
                                            Keyboard.dismiss();
                                        }}
                                    >
                                        <Text style={styles.quickChipText}>All</Text>
                                    </Pressable>
                                </View>
                            )}

                            {error ? <Text style={styles.errorText}>{error}</Text> : null}

                            <Pressable
                                style={[
                                    styles.actionBtn,
                                    styles.withdrawBtn,
                                    (!isValid || loading) && styles.btnDisabled,
                                ]}
                                onPress={onWithdraw}
                                disabled={!isValid || loading}
                            >
                                {loading ? (
                                    <ActivityIndicator color={colors.text} />
                                ) : (
                                    <Text style={styles.actionBtnText}>
                                        {insufficient
                                            ? "Insufficient balance"
                                            : isValid
                                                ? `Withdraw — €${amountEur.toFixed(2)}`
                                                : "Enter an amount"}
                                    </Text>
                                )}
                            </Pressable>
                        </ScrollView>
                    </KeyboardAvoidingView>
                </View>
            </View>
        </Modal>
    );
}

// ─── Profile Screen ───────────────────────────────────────────────────────────

type BetUiStatus = "LIVE" | "WON" | "LOST";

const toBetUiStatus = (status: Bet["status"]): BetUiStatus | undefined => {
    if (status === "accepted") return "LIVE";
    if (status === "settled_won") return "WON";
    if (status === "settled_lost") return "LOST";
    return undefined;
};

export function ProfileScreen() {
    const { account, wallet, bets, markets } = useAppStore();
    const [showDeposit, setShowDeposit] = useState(false);
    const [showWithdraw, setShowWithdraw] = useState(false);
    const [successSheet, setSuccessSheet] = useState<string | null>(null);
    const [txHistory, setTxHistory] = useState<
        { id: string; type: "deposit" | "withdrawal"; amount: number; date: Date }[]
    >([]);

    const handleSuccess = (title: string, amount: number, type: "deposit" | "withdrawal") => {
        setSuccessSheet(title);
        setTxHistory((prev) =>
            [{ id: Date.now().toString(), type, amount, date: new Date() }, ...prev].slice(0, 20)
        );
    };

    const marketById = useMemo(
        () => new Map(markets.map((market) => [market.market_id, market])),
        [markets],
    );

    const picks = useMemo(
        () =>
            bets
                .map((bet) => {
                    const uiStatus = toBetUiStatus(bet.status);
                    if (!uiStatus) return undefined;
                    return {
                        bet,
                        uiStatus,
                        question: marketById.get(bet.market_id)?.question ?? "Prediction",
                    };
                })
                .filter(
                    (
                        value,
                    ): value is { bet: Bet; uiStatus: BetUiStatus; question: string } => Boolean(value),
                ),
        [bets, marketById],
    );

    const metrics = useMemo(() => {
        return {
            total: picks.length,
            won: picks.filter((b) => b.uiStatus === "WON").length,
            lost: picks.filter((b) => b.uiStatus === "LOST").length,
        };
    }, [picks]);

    return (
        <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
            <ScrollView contentContainerStyle={styles.content}>
                <Text style={styles.username}>{account?.username ?? "User"}</Text>
                <Text style={styles.screenTitle}>Profile</Text>

                <View style={styles.totalCard}>
                    <Text style={styles.totalLabel}>Total</Text>
                    <AnimatedBalance balance={wallet?.balance ?? 0} />
                </View>

                <View style={styles.metricsCard}>
                    <Text style={styles.blockTitle}>Lifetime Metrics</Text>
                    <View style={styles.metricsRow}>
                        {[
                            { label: "Total", value: metrics.total, col: undefined },
                            { label: "Won", value: metrics.won, col: colors.good },
                            { label: "Lost", value: metrics.lost, col: colors.bad },
                        ].map(({ label, value, col }) => (
                            <View key={label} style={styles.metricBox}>
                                <Text style={styles.metricLabel}>{label}</Text>
                                <Text style={[styles.metricValue, col ? { color: col } : undefined]}>
                                    {value}
                                </Text>
                            </View>
                        ))}
                    </View>
                </View>

                <View style={styles.fundsCard}>
                    <Text style={styles.blockTitle}>Funds</Text>
                    <View style={styles.fundsRow}>
                        <Pressable
                            style={[styles.fundBtn, styles.addBtn]}
                            onPress={() => setShowDeposit(true)}
                        >
                            <Text style={styles.fundBtnArrow}>↑</Text>
                            <Text style={styles.fundBtnText}>Add Funds</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.fundBtn, styles.withdrawFundBtn]}
                            onPress={() => setShowWithdraw(true)}
                        >
                            <Text style={[styles.fundBtnArrow, { color: "#e87a8a" }]}>↓</Text>
                            <Text style={styles.fundBtnText}>Withdraw Funds</Text>
                        </Pressable>
                    </View>
                </View>

                <View style={styles.picksCard}>
                    <Text style={styles.blockTitle}>Predictions</Text>
                    {picks.length === 0 ? (
                        <Text style={styles.picksEmpty}>No predictions yet.</Text>
                    ) : (
                        picks.slice(0, 8).map(({ bet, uiStatus, question }) => (
                            <View key={bet.bet_id} style={styles.pickRow}>
                                <View style={styles.pickBody}>
                                    <Text style={styles.pickQuestion} numberOfLines={2}>
                                        {question}
                                    </Text>
                                    <Text style={styles.pickMeta}>
                                        Stake €{bet.stake.toFixed(2)}
                                        {uiStatus === "WON" && typeof bet.payout === "number"
                                            ? ` • +€${bet.payout.toFixed(2)}`
                                            : ""}
                                    </Text>
                                </View>
                                <View
                                    style={[
                                        styles.pickStatus,
                                        uiStatus === "LIVE" && styles.pickStatusLive,
                                        uiStatus === "WON" && styles.pickStatusWon,
                                        uiStatus === "LOST" && styles.pickStatusLost,
                                    ]}
                                >
                                    <Text style={styles.pickStatusText}>{uiStatus}</Text>
                                </View>
                            </View>
                        ))
                    )}
                </View>

                {txHistory.length > 0 && (
                    <View style={styles.txCard}>
                        <Text style={styles.blockTitle}>Recent Transactions</Text>
                        <ScrollView style={styles.txScroll} nestedScrollEnabled scrollIndicatorInsets={{ right: 1 }}>
                            {txHistory.slice(0, 3).map((tx) => {
                                const isDeposit = tx.type === "deposit";
                                const d = tx.date;
                                const dateStr = `${d.getDate().toString().padStart(2, "0")}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getFullYear()}  ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
                                return (
                                    <View key={tx.id} style={styles.txRow}>
                                        <View style={[styles.txIcon, { backgroundColor: isDeposit ? "#17483d" : "#4a2330" }]}>
                                            <Text style={[styles.txIconText, { color: isDeposit ? "#58dbad" : "#e87a8a" }]}>
                                                {isDeposit ? "↑" : "↓"}
                                            </Text>
                                        </View>
                                        <View style={{ flex: 1, gap: 2 }}>
                                            <Text style={styles.txLabel}>{isDeposit ? "Deposit" : "Withdrawal"}</Text>
                                            <Text style={styles.txDate}>{dateStr}</Text>
                                        </View>
                                        <Text style={[styles.txAmount, { color: isDeposit ? "#58dbad" : "#e87a8a" }]}>
                                            {isDeposit ? "+" : "-"}€{tx.amount.toFixed(2)}
                                        </Text>
                                    </View>
                                );
                            })}
                        </ScrollView>
                    </View>
                )}
            </ScrollView>

            <DepositModal
                visible={showDeposit}
                onClose={() => setShowDeposit(false)}
                onSuccess={handleSuccess}
            />
            <WithdrawModal
                visible={showWithdraw}
                onClose={() => setShowWithdraw(false)}
                onSuccess={handleSuccess}
            />
            <ApplePaySheet
                visible={!!successSheet}
                title={successSheet ?? ""}
                onDone={() => setSuccessSheet(null)}
            />
        </SafeAreaView>
    );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 14, gap: 12 },

    username: { color: colors.text, fontSize: 40, fontWeight: "900", letterSpacing: 0.2 },
    screenTitle: { color: colors.muted, fontSize: 32, fontWeight: "800" },

    odometerPrefix: { fontSize: 34, fontWeight: "900", letterSpacing: 0.3 },
    odometerChar: { fontSize: 34, fontWeight: "900" },

    totalCard: {
        borderWidth: 1, borderColor: colors.border, borderRadius: 16,
        padding: 14, backgroundColor: colors.surface, gap: 6,
    },
    totalLabel: { color: colors.muted, fontSize: 12, fontWeight: "700" },

    metricsCard: {
        borderWidth: 1, borderColor: colors.border, borderRadius: 16,
        padding: 14, backgroundColor: colors.surface, gap: 10,
    },
    metricsRow: { flexDirection: "row", gap: 8 },
    metricBox: {
        flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10,
        backgroundColor: "#0f172a", paddingVertical: 10, alignItems: "center", gap: 4,
    },
    metricLabel: { color: colors.muted, fontSize: 11, fontWeight: "700" },
    metricValue: { color: colors.text, fontSize: 20, fontWeight: "900" },

    fundsCard: {
        borderWidth: 1, borderColor: colors.border, borderRadius: 16,
        padding: 14, backgroundColor: colors.surface, gap: 10,
    },
    fundsRow: { flexDirection: "row", gap: 8 },
    blockTitle: { color: colors.text, fontSize: 15, fontWeight: "800" },
    fundBtn: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
    addBtn: { borderColor: "#58dbad", backgroundColor: "#17483d" },
    withdrawFundBtn: { borderColor: "#c26d83", backgroundColor: "#4a2330" },
    fundBtnText: { color: colors.text, fontWeight: "800" },
    picksCard: {
        borderWidth: 1, borderColor: colors.border, borderRadius: 16,
        padding: 14, backgroundColor: colors.surface, gap: 10,
    },
    picksEmpty: {
        color: colors.muted,
        fontSize: 13,
        fontWeight: "600",
    },
    pickRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        backgroundColor: "#0f172a",
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    pickBody: {
        flex: 1,
        gap: 4,
    },
    pickQuestion: {
        color: colors.text,
        fontSize: 13,
        fontWeight: "700",
        lineHeight: 18,
    },
    pickMeta: {
        color: colors.muted,
        fontSize: 11,
        fontWeight: "600",
    },
    pickStatus: {
        borderRadius: 999,
        borderWidth: 1,
        paddingHorizontal: 10,
        paddingVertical: 4,
        minWidth: 58,
        alignItems: "center",
    },
    pickStatusLive: {
        borderColor: "#4f9ef8",
        backgroundColor: "rgba(79,158,248,0.18)",
    },
    pickStatusWon: {
        borderColor: "#58dbad",
        backgroundColor: "rgba(88,219,173,0.18)",
    },
    pickStatusLost: {
        borderColor: "#e87a8a",
        backgroundColor: "rgba(232,122,138,0.18)",
    },
    pickStatusText: {
        color: colors.text,
        fontSize: 11,
        fontWeight: "900",
        letterSpacing: 0.4,
    },

    // ── Modal overlay ──────────────────────────────────────────────────────────
    overlay: {
        flex: 1,
        backgroundColor: "rgba(0,0,0,0.88)",
        justifyContent: "flex-end",
    },
    modalSheet: {
        backgroundColor: colors.bg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        borderWidth: 1,
        borderColor: colors.border,
        height: "93%",
        paddingBottom: Platform.OS === "ios" ? 34 : 16,
    },
    dragHandle: {
        width: 38, height: 4, borderRadius: 2,
        backgroundColor: colors.border,
        alignSelf: "center",
        marginTop: 10, marginBottom: 4,
    },

    // ── Sheet content ──────────────────────────────────────────────────────────
    sheetContent: { padding: 20, gap: 16 },
    sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sheetTitle: { color: colors.text, fontSize: 22, fontWeight: "900" },
    closeBtn: {
        width: 32, height: 32, borderRadius: 16,
        backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
        alignItems: "center", justifyContent: "center",
    },
    closeBtnText: { color: colors.muted, fontSize: 13, fontWeight: "700" },

    balanceCard: {
        borderWidth: 1, borderColor: colors.border, borderRadius: 14,
        padding: 14, backgroundColor: colors.surface, gap: 4,
    },
    balLabel: { color: colors.muted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
    balValue: { color: colors.text, fontSize: 28, fontWeight: "900" },

    inputCard: {
        borderWidth: 1, borderColor: colors.border, borderRadius: 14,
        padding: 14, backgroundColor: colors.surface, gap: 10,
    },
    cardTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
    inputRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    currSym: { color: colors.muted, fontSize: 26, fontWeight: "700" },
    amountInput: { flex: 1, color: colors.text, fontSize: 32, fontWeight: "900", paddingVertical: 4 },
    hint: { color: colors.accentOrange, fontSize: 12, fontWeight: "600" },

    quickRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    quickChip: {
        flex: 1, minWidth: 60,
        borderWidth: 1, borderColor: colors.border, borderRadius: 10,
        paddingVertical: 10, alignItems: "center", backgroundColor: colors.surface,
    },
    quickChipText: { color: colors.text, fontWeight: "800", fontSize: 14 },

    errorText: { color: colors.bad, fontSize: 12, fontWeight: "600", textAlign: "center" },

    actionBtn: { borderRadius: 14, paddingVertical: 16, alignItems: "center" },
    stripeBtn: { backgroundColor: "#635BFF" },
    withdrawBtn: { backgroundColor: "#4a2330", borderWidth: 1, borderColor: "#c26d83" },
    btnDisabled: { opacity: 0.4 },
    actionBtnText: { color: "#fff", fontWeight: "900", fontSize: 17 },

    fundBtnArrow: { color: "#58dbad", fontSize: 18, fontWeight: "900" },

    // ── Transaction history ────────────────────────────────────────────────────
    txCard: {
        borderWidth: 1, borderColor: colors.border, borderRadius: 16,
        padding: 14, backgroundColor: colors.surface, gap: 10,
    },
    txScroll: { maxHeight: 180 },
    txRow: {
        flexDirection: "row", alignItems: "center", gap: 12,
        paddingVertical: 10,
        borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    txIcon: {
        width: 36, height: 36, borderRadius: 18,
        alignItems: "center", justifyContent: "center",
    },
    txIconText: { fontSize: 18, fontWeight: "900" },
    txLabel: { color: colors.text, fontSize: 14, fontWeight: "700" },
    txDate: { color: colors.muted, fontSize: 11, fontWeight: "500" },
    txAmount: { fontSize: 15, fontWeight: "900" },

    // ── Apple Pay success sheet ────────────────────────────────────────────────
    apBackdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: "rgba(0,0,0,0.72)",
        justifyContent: "flex-end",
    },
    apSheet: {
        backgroundColor: "#101a10",
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        borderWidth: 1, borderColor: "#1e2e1e",
        paddingTop: 10, paddingHorizontal: 28, paddingBottom: 50,
        alignItems: "center", gap: 16,
    },
    apHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: "#2a3a2a", marginBottom: 4 },
    apTitle: { color: colors.text, fontSize: 20, fontWeight: "800", textAlign: "center" },
    apDoneBtn: {
        width: "100%", backgroundColor: colors.good,
        borderRadius: 14, paddingVertical: 14, alignItems: "center",
    },
    apDoneBtnText: { color: colors.bg, fontWeight: "900", fontSize: 16 },
});
