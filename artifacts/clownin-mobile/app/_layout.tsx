import React, { useEffect } from 'react';
import { Alert } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform } from 'react-native';
import { setBaseUrl } from '@workspace/api-client-react';
import { AuthProvider } from '@/contexts/AuthContext';
import { initializeRevenueCat, SubscriptionProvider } from '@/lib/revenuecat';

// Initialize RevenueCat once at app startup, before any purchase UI is shown.
// Silently skips if API keys are not yet configured (dev without RC set up).
try {
  initializeRevenueCat();
} catch (err: unknown) {
  if (
    err instanceof Error &&
    err.message.includes('RevenueCat Public API Keys not configured')
  ) {
    console.log('[RC] Skipping RevenueCat init — API keys not set yet');
  } else {
    Alert.alert('RevenueCat Unavailable', err instanceof Error ? err.message : 'Unknown error');
  }
}

// Resolve the correct API base URL at runtime so it works both in Expo Go
// (native) and in the Expo web preview (browser on any device).
//
// The Expo web preview runs at:  <id>.expo.kirk.replit.dev
// The API server lives at:       <id>.kirk.replit.dev/api
// → strip ".expo" from the hostname to get the API domain.
// On native, fall back to the EXPO_PUBLIC_DOMAIN env var baked in at bundle time.
export function resolveApiBaseUrl(): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const host = window.location.hostname;
    const apiHost = host.replace('.expo.kirk.replit.dev', '.kirk.replit.dev');
    if (apiHost !== host) return `https://${apiHost}`;
    // Not on the Expo subdomain — use relative paths (same-origin proxy)
    return null;
  }
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : null;
}

setBaseUrl(resolveApiBaseUrl());

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
    mutations: { retry: 0 },
  },
});

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="(app)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <AuthProvider>
                <SubscriptionProvider>
                  <RootLayoutNav />
                </SubscriptionProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
