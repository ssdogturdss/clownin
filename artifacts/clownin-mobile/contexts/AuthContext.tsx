/**
 * Auth is disabled — the app runs without user accounts.
 * Every request is made as the system user; no login, no token management.
 */
import React, { createContext, useContext } from 'react';
import { setAuthTokenGetter, setUnauthorizedHandler } from '@workspace/api-client-react';
import type { UserProfile } from '@workspace/api-client-react';

// Keep existing API-client Authorization handling stable; the server ignores it.
setAuthTokenGetter(() => 'no-auth');
setUnauthorizedHandler(null);

const SYNTHETIC_USER: UserProfile = {
  id: 1,
  username: 'admin',
  email: 'ss@clownin.dev',
  createdAt: new Date(0).toISOString(),
  subscriptionTier: 'pro',
  dailyMessageCount: 0,
  dailyMessageLimit: null,
};

const STATIC_VALUE = {
  token: 'no-auth' as string | null,
  user: SYNTHETIC_USER as UserProfile | null,
  isLoading: false,
  login: async (_token: string, _user: UserProfile) => {},
  logout: async () => {},
};

const AuthContext = createContext(STATIC_VALUE);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <AuthContext.Provider value={STATIC_VALUE}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}