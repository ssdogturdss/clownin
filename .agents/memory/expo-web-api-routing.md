---
name: Expo web API routing
description: How to resolve the correct API base URL from the Expo web preview subdomain.
---

The Expo web preview runs on `<id>.expo.kirk.replit.dev`.
The API server is routed at `<id>.kirk.replit.dev/api/...` (main dev domain).

These are different origins. Relative paths from the expo subdomain do NOT reach the API.

**Rule:** On `Platform.OS === 'web'`, strip `.expo` from `window.location.hostname`:
```ts
const apiHost = window.location.hostname.replace('.expo.kirk.replit.dev', '.kirk.replit.dev');
setBaseUrl(`https://${apiHost}`);
```

**Why:** Replit's path-based proxy routes `/api` only on the main dev domain, not the expo subdomain. Baking in `EXPO_PUBLIC_DOMAIN` at bundle time works for native but not for web (wrong subdomain after hydration).

**How to apply:** Any place that constructs an absolute API URL must apply this transform — both `_layout.tsx` (setBaseUrl) and `project/[id].tsx` (SSE execute URL) need it.
