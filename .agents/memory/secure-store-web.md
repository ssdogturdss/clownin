---
name: SecureStore web fallback
description: expo-secure-store crashes on web; use localStorage instead.
---

`expo-secure-store` throws `setValueWithKeyAsync is not a function` on Expo web (browser).

**Fix:** In `AuthContext.tsx`, a `storage` shim checks `Platform.OS === 'web'` and routes to `localStorage`; native uses SecureStore as normal.

**Why:** SecureStore uses native Keychain/Keystore APIs unavailable in the browser.

**How to apply:** Any new screen or context that needs to persist auth tokens or session data must use this shim (or import it), never call SecureStore directly.
