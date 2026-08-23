import { Platform } from 'react-native';

function normalizeBaseUrl(value: string): string {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, '');
}

/**
 * Resolves the API origin without relying on a hosting provider's URL scheme.
 *
 * Native apps must set EXPO_PUBLIC_API_URL. Web builds can omit it when the API
 * is reverse-proxied at the same origin. EXPO_PUBLIC_DOMAIN remains as a
 * compatibility alias for deployments that supply only a hostname.
 */
export function resolveApiBaseUrl(): string | null {
  const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (configuredApiUrl) return normalizeBaseUrl(configuredApiUrl);

  const legacyDomain = process.env.EXPO_PUBLIC_DOMAIN?.trim();
  if (legacyDomain) return normalizeBaseUrl(legacyDomain);

  return Platform.OS === 'web' ? null : null;
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolveApiBaseUrl() ?? ''}${normalizedPath}`;
}