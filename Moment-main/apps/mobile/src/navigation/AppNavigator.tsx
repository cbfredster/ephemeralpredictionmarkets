import { Ionicons } from "@expo/vector-icons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";

import { DevScreen } from "../screens/DevScreen";
import { F1Screen } from "../screens/F1Screen";
import { ProfileScreen } from "../screens/ProfileScreen";
import { StocksScreen } from "../screens/StocksScreen";
import { colors } from "../theme/tokens";

const Tabs = createBottomTabNavigator();

const ICON_MAP: Record<string, keyof typeof Ionicons.glyphMap> = {
  Sports: "speedometer",
  Stocks: "trending-up",
  Profile: "person-circle",
  Dev: "construct",
};

export function AppNavigator() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 84,
          paddingBottom: 10,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.accentBlue,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "700",
        },
        tabBarIcon: ({ color, size }) => (
          <Ionicons
            name={ICON_MAP[route.name] ?? "ellipse"}
            size={size}
            color={color}
          />
        ),
      })}
    >
      <Tabs.Screen name="Sports" component={F1Screen} />
      <Tabs.Screen name="Stocks" component={StocksScreen} />
      <Tabs.Screen name="Profile" component={ProfileScreen} />
      <Tabs.Screen name="Dev" component={DevScreen} />
    </Tabs.Navigator>
  );
}
