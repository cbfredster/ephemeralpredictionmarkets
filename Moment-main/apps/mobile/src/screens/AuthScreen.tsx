import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";
import { colors, layout } from "../theme/tokens";

type Mode = "login" | "create";

export function AuthScreen() {
  const setSession = useAppStore((s) => s.setSession);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const onSubmit = async () => {
    const cleanedUsername = username.trim();
    const cleanedPin = pin.trim();
    if (!cleanedUsername || !cleanedPin) {
      setError("Enter username and PIN");
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      const response =
        mode === "login"
          ? await api.login({ username: cleanedUsername, pin: cleanedPin })
          : await api.createUser({ username: cleanedUsername, pin: cleanedPin });

      setSession({
        userId: response.user.user_id,
        account: response.user,
        wallet: response.wallet,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Auth failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>Moment</Text>
          <Text style={styles.subtitle}>Log in or create a profile to continue</Text>

          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeButton, mode === "login" && styles.modeButtonActive]}
              onPress={() => setMode("login")}
            >
              <Text style={styles.modeText}>Login</Text>
            </Pressable>
            <Pressable
              style={[styles.modeButton, mode === "create" && styles.modeButtonActive]}
              onPress={() => setMode("create")}
            >
              <Text style={styles.modeText}>Create</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <TextInput
              value={username}
              onChangeText={setUsername}
              placeholder="Username"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <TextInput
              value={pin}
              onChangeText={setPin}
              placeholder="PIN"
              placeholderTextColor={colors.muted}
              secureTextEntry
              keyboardType="number-pad"
              style={styles.input}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable style={styles.cta} onPress={onSubmit} disabled={submitting}>
              <Text style={styles.ctaText}>
                {submitting ? "Please wait..." : mode === "login" ? "Login" : "Create Profile"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 18,
    paddingTop: 20,
    paddingBottom: 24,
    gap: 12,
  },
  title: {
    color: colors.text,
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: 0.1,
    textAlign: "left",
  },
  subtitle: {
    color: colors.muted,
    textAlign: "left",
    marginBottom: 8,
    fontWeight: "600",
  },
  modeRow: {
    flexDirection: "row",
    gap: 8,
  },
  modeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusSm,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.bgElevated,
  },
  modeButtonActive: {
    borderColor: colors.accentBlue,
    backgroundColor: "#172b45",
  },
  modeText: {
    color: colors.text,
    fontWeight: "800",
  },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusLg,
    backgroundColor: colors.card,
    padding: 14,
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: layout.radiusSm,
    backgroundColor: colors.bgElevated,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontWeight: "600",
  },
  cta: {
    borderWidth: 1,
    borderColor: colors.accentBlue,
    borderRadius: layout.radiusSm,
    backgroundColor: "#1f5f8f",
    paddingVertical: 12,
    alignItems: "center",
  },
  ctaText: {
    color: colors.text,
    fontWeight: "800",
  },
  error: {
    color: colors.bad,
    fontSize: 12,
    fontWeight: "600",
  },
});
