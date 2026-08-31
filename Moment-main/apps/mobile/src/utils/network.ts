import Constants from "expo-constants";

const hostFromExpo = (): string => {
  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return "localhost";
  return hostUri.split(":")[0];
};

export const API_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? `http://${hostFromExpo()}:4000`;
export const WS_URL = process.env.EXPO_PUBLIC_WS_BASE_URL ?? API_URL;
