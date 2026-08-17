import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAuthTokenGetter, setUnauthorizedHandler, customFetch } from '@workspace/api-client-react';
import type { UserProfile } from '@workspace/api-client-react';
import Purchases from 'react-native-purchases';

// ---------------------------------------------------------------------------
// Auto-login credentials — no login screen shown; app always signs in as this
// account on first launch (or after a token expiry).
// ---------------------------------------------------------------------------
const AUTO_LOGIN_EMAIL = 'ss@clownin.dev';
const AUTO_LOGIN_PASSWORD = '1211';

async function fetchAutoLoginToken(): Promise<{ token: string; user: UserProfile } | null> {
  try {
    const res = await customFetch<{ token: string; user: UserProfile }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: AUTO_LOGIN_EMAIL, password: AUTO_LOGIN_PASSWORD }),
    });
    return res;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Platform-aware key-value storage
// expo-secure-store is native-only; fall back to localStorage on web.
// ---------------------------------------------------------------------------
const storage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try { return localStorage.getItem(key); } catch { return null; }
    }
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

interface AuthContextValue {
  token: string | null;
  user: UserProfile | null;
  isLoading: boolean;
  login: (token: string, user: UserProfile) => Promise<void>;
  logout: () => Promise<void>;
}

const TOKEN_KEY = 'clownin_jwt';
const USER_KEY = 'clownin_user';

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Decode the JWT payload and return the `exp` timestamp (in seconds).
 * Returns null if the token is malformed or has no `exp` field.
 */
function getTokenExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // atob is available in React Native via the Hermes engine
    const payload = JSON.parse(atob(parts[1]));
    if (typeof payload.exp !== 'number') return null;
    return payload.exp;
  } catch {
    return null;
  }
}

/** Returns true if the token's `exp` has already passed. */
function isTokenExpired(token: string): boolean {
  const exp = getTokenExpiry(token);
  if (exp === null) return false; // no expiry field → treat as valid
  return Date.now() >= exp * 1000;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  const applyToken = useCallback((t: string | null) => {
    setAuthTokenGetter(t ? () => t : null);
  }, []);

  // Keep refs to login/logout so async handlers never capture stale closures
  const logoutRef = useRef<() => Promise<void>>(async () => {});
  const loginRef = useRef<(token: string, user: UserProfile) => Promise<void>>(async () => {});

  const logout = useCallback(async () => {
    await Promise.all([
      storage.removeItem(TOKEN_KEY),
      storage.removeItem(USER_KEY),
    ]);
    setToken(null);
    setUser(null);
    applyToken(null);
    queryClient.clear();
    // Log out of RevenueCat so the next user gets a fresh anonymous identity.
    try {
      await Purchases.logOut();
    } catch {
      // RC logOut throws when the current user is already anonymous — ignore.
    }
    // Clear all per-project editor state (scroll positions, selected file, terminal open state)
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const staleKeys = allKeys.filter(
        (k) => k.startsWith('scroll_') || k.startsWith('selected_file_') || k.startsWith('terminal_open_'),
      );
      if (staleKeys.length > 0) {
        await AsyncStorage.multiRemove(staleKeys);
      }
    } catch {
      // cleanup failure is non-critical
    }
  }, [applyToken, queryClient]);

  // Keep refs in sync with latest callbacks
  useEffect(() => { logoutRef.current = logout; }, [logout]);
  useEffect(() => { loginRef.current = login; });

  // Register a global 401 handler — clears credentials and re-logs in automatically
  useEffect(() => {
    setUnauthorizedHandler(async () => {
      await logoutRef.current();
      const result = await fetchAutoLoginToken();
      if (result) {
        await loginRef.current(result.token, result.user);
      } else {
        // API unreachable — stay on current screen, will retry next request
      }
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Restore persisted session on app start; auto-login if none found or expired
  useEffect(() => {
    (async () => {
      try {
        const [storedToken, storedUser] = await Promise.all([
          storage.getItem(TOKEN_KEY),
          storage.getItem(USER_KEY),
        ]);

        const hasValid = storedToken && storedUser && !isTokenExpired(storedToken);

        if (hasValid) {
          const parsedUser = JSON.parse(storedUser!) as UserProfile;
          setToken(storedToken!);
          setUser(parsedUser);
          applyToken(storedToken!);
          try { await Purchases.logIn(String(parsedUser.id)); } catch { /* non-fatal */ }
        } else {
          // No valid stored session — auto-login silently
          if (storedToken) {
            await Promise.all([storage.removeItem(TOKEN_KEY), storage.removeItem(USER_KEY)]);
          }
          const result = await fetchAutoLoginToken();
          if (result) {
            await loginRef.current(result.token, result.user);
          }
          // If auto-login fails (API down), isLoading finishes and index.tsx
          // will redirect to login as the fallback.
        }
      } catch {
        // ignore storage errors
      } finally {
        setIsLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyToken]);

  const login = async (newToken: string, newUser: UserProfile) => {
    await Promise.all([
      storage.setItem(TOKEN_KEY, newToken),
      storage.setItem(USER_KEY, JSON.stringify(newUser)),
    ]);
    setToken(newToken);
    setUser(newUser);
    applyToken(newToken);
    // Identify this user in RevenueCat so that the app_user_id in webhook
    // events matches our DB user ID (numeric ID as a string).
    try {
      await Purchases.logIn(String(newUser.id));
    } catch {
      // RC SDK may not be configured in dev — non-fatal.
    }
  };

  return (
    <AuthContext.Provider value={{ token, user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
