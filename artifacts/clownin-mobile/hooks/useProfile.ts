import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { resolveApiBaseUrl } from '@/app/_layout';
import type { UserProfile } from '@workspace/api-client-react';

// Re-export the canonical generated type so callers don't need to import from the lib directly.
export type { UserProfile };

export const PROFILE_QUERY_KEY = ['profile'];

export function useProfile() {
  const { token } = useAuth();
  return useQuery<UserProfile>({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: async () => {
      const baseUrl = resolveApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });
      if (!res.ok) throw new Error('Failed to fetch profile');
      return res.json() as Promise<UserProfile>;
    },
    enabled: !!token,
    staleTime: 30_000,
  });
}
