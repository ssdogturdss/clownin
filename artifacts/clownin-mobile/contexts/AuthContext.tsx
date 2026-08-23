/**
 * Auth context — per-user session management backed by SecureStore (native)
 * or localStorage (web).
 *
 * On mount, checks secure storage for a persisted token.  `isLoading` stays
 * `true` until the check completes so the root index screen and the (app)
 * layout can gate all navigation behind it — no authenticated API calls fire
 * before the token is known.
 *
 * The `login()` helper persists the token via SecureStore/localStorage and
 * associates the user with RevenueCat (`Purchases.logIn`) so entitlement
 * checks reflect the correct account.  `logout()` clears the token, the React
 * Query cache (preventing any prior-user data from being rendered to the next
 * user), and reverts RevenueCat to anonymous mode (`Purchases.logOut`).
 * The unauthorized handler does the same in the live session and reroutes to
 * the login screen without requiring a cold restart.
 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import Purchases from 'react-native-purchases';
import { useQueryClient } from '@tanstack/react-query';
import { setAuthTokenGetter, setUnauthorizedHandler } from '@workspace/api-client-react';
import type { UserProfile } from '@workspace/api-client-react';

// ── Secure storage shim ────────────────────────────────────────────────────────
// expo-secure-store uses native Keychain / Keystore APIs unavailable in a
// browser.  On web we fall back to localStorage (acceptable for a single-owner
// developer tool; a production multi-user app should prefer httpOnly cookies).

const TOKEN_KEY = 'clownin_auth_token';
const USER_KEY  = 'clownin_auth_user';

const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return localStorage.getItem(key);
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') { localStorage.setItem(key, value); return; }
    await SecureStore.setItemAsync(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') { localStorage.removeItem(key); return; }
    await SecureStore.deleteItemAsync(key);
  },
};

// ── RevenueCat identity helpers ────────────────────────────────────────────────
// RevenueCat must know which user is active so purchase entitlements are
// attributed correctly.  On web (where the RC SDK is unavailable) and when RC
// is not yet configured, these calls are silently skipped.

async function rcLogIn(userId: number): Promise<void> {
  if (Platform.OS === 'web') return;
  try { await Purchases.logIn(String(userId)); } catch { /* RC not configured */ }
}

async function rcLogOut(): Promise<void> {
  if (Platform.OS === 'web') return;
  try { await Purchases.logOut(); } catch { /* RC not configured */ }
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface AuthContextValue {
  token: string | null;
  user: UserProfile | null;
  isLoading: boolean;
  login: (token: string, user: UserProfile) => Promise<void>;
  logout: () => Promise<void>;
}

// Module-level token reference — stays current without closing over stale state.
let _currentToken: string | null = null;

// Register the token getter immediately so the API client always reads the
// latest value even before the AuthProvider first renders.
setAuthTokenGetter(() => _currentToken ?? '');

// ── Context ────────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue>({
  token: null,
  user: null,
  isLoading: true,
  login: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken]       = useState<string | null>(null);
  const [user, setUser]         = useState<UserProfile | null>(null);
  const [isLoading, setLoading] = useState(true);

  // useQueryClient() works here because AuthProvider sits inside
  // QueryClientProvider in _layout.tsx.
  const queryClient = useQueryClient();

  /**
   * Clears all auth state, secure storage, React Query cache, and reverts
   * RevenueCat to anonymous mode.  Call before routing to login to prevent
   * any prior-user data from being visible to the next user.
   */
  const clearSession = async () => {
    _currentToken = null;
    setToken(null);
    setUser(null);
    // Clear all cached queries so no prior-user data (projects, profile, admin)
    // can be rendered to a subsequent user before their own fetch completes.
    queryClient.clear();
    await Promise.all([
      secureStorage.removeItem(TOKEN_KEY),
      secureStorage.removeItem(USER_KEY),
      rcLogOut(),
    ]);
  };

  // Wire the unauthorized handler inside the component so it can update React
  // state directly and invoke clearSession with access to the live queryClient.
  // Without this, a 401 only clears memory/storage but the UI stays visually
  // authenticated and React Query's stale cache can serve prior-user data.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession().catch(() => {});
      router.replace('/(auth)/login');
    });
    return () => {
      setUnauthorizedHandler(null);
    };
    // clearSession is redefined on each render but captures stable setters —
    // intentionally omitted from deps to avoid re-registering on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rehydrate from secure storage once on mount.
  useEffect(() => {
    (async () => {
      try {
        const [storedToken, storedUser] = await Promise.all([
          secureStorage.getItem(TOKEN_KEY),
          secureStorage.getItem(USER_KEY),
        ]);
        if (storedToken && storedUser) {
          const parsedUser = JSON.parse(storedUser) as UserProfile;
          _currentToken = storedToken;
          setToken(storedToken);
          setUser(parsedUser);
          // Restore the RevenueCat identity for the persisted user so purchase
          // entitlements are attributed to the correct account on resume.
          await rcLogIn(parsedUser.id);
        }
      } catch {
        // Storage unavailable — start unauthenticated.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = async (t: string, u: UserProfile) => {
    _currentToken = t;
    setToken(t);
    setUser(u);
    await Promise.all([
      secureStorage.setItem(TOKEN_KEY, t),
      secureStorage.setItem(USER_KEY, JSON.stringify(u)),
      rcLogIn(u.id),
    ]);
  };

  const logout = async () => {
    await clearSession();
  };

  return (
    <AuthContext.Provider value={{ token, user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
