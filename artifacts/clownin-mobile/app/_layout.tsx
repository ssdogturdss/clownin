import React, { useEffect } from 'react';
import { Alert, Image, View } from 'react-native';
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
import { setBaseUrl } from '@workspace/api-client-react';
import { AuthProvider } from '@/contexts/AuthContext';
import { initializeRevenueCat, SubscriptionProvider } from '@/lib/revenuecat';
import { resolveApiBaseUrl } from '@/lib/apiUrl';

export { resolveApiBaseUrl } from '@/lib/apiUrl';

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
            {/* Brand wallpaper — 25% opacity behind all screens */}
            <Image
              source={require('../assets/images/wallpaper.png')}
              style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.25 }}
              resizeMode="cover"
            />
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
