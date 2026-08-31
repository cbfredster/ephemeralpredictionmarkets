import { useEffect } from "react";

import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { StripeProvider } from "@stripe/stripe-react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppNavigator } from "./src/navigation/AppNavigator";
import { AuthScreen } from "./src/screens/AuthScreen";
import { api } from "./src/services/api";
import { connectSocket } from "./src/services/socket";
import { useAppStore } from "./src/store/useAppStore";
import { colors } from "./src/theme/tokens";

const STRIPE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bgElevated,
    border: colors.border,
    text: colors.text,
    primary: colors.accentGreen,
  },
};

export default function App() {
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const userId = useAppStore((s) => s.userId);
  const setMarkets = useAppStore((s) => s.setMarkets);
  const setBets = useAppStore((s) => s.setBets);
  const setWallet = useAppStore((s) => s.setWallet);
  const setAccount = useAppStore((s) => s.setAccount);
  const setConnection = useAppStore((s) => s.setConnection);
  const upsertMarket = useAppStore((s) => s.upsertMarket);
  const upsertBet = useAppStore((s) => s.upsertBet);

  useEffect(() => {
    if (!isAuthenticated || !userId) {
      setConnection("disconnected");
      return;
    }

    let dead = false;

    const bootstrap = async () => {
      setConnection("connecting");
      try {
        const [markets, bets, wallet, account] = await Promise.all([
          api.getLiveMarkets(),
          api.getBets(userId),
          api.getWallet(userId),
          api.getUser(userId),
        ]);
        if (dead) return;
        setMarkets(markets);
        setBets(bets);
        setWallet(wallet);
        setAccount(account);
      } catch {
        if (!dead) setConnection("disconnected");
      }
    };

    void bootstrap();

    const socket = connectSocket({
      onConnection: (state) => setConnection(state),
      onMarket: (market) => upsertMarket(market),
      onBet: (bet) => {
        if (bet.user_id === userId) upsertBet(bet);
      },
      onWallet: (wallet) => {
        if (wallet.user_id === userId) setWallet(wallet);
      },
    });

    return () => {
      dead = true;
      socket.disconnect();
    };
  }, [isAuthenticated, setAccount, setBets, setConnection, setMarkets, setWallet, upsertBet, upsertMarket, userId]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {isAuthenticated ? (
        <StripeProvider publishableKey={STRIPE_KEY} merchantIdentifier="merchant.com.moment">
          <NavigationContainer theme={navTheme}>
            <AppNavigator />
          </NavigationContainer>
        </StripeProvider>
      ) : (
        <AuthScreen />
      )}
    </SafeAreaProvider>
  );
}
