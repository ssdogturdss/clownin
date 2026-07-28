import { useEffect, useState, useCallback } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { useLogin } from '@workspace/api-client-react';

export default function RootIndex() {
  const { token, isLoading, login } = useAuth();
  const colors = useColors();
  const loginMutation = useLogin();
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  const doLogin = useCallback(() => {
    setError('');
    loginMutation
      .mutateAsync({ data: { email: 'demo@clownin.dev', password: 'demo1234' } })
      .then(async (res) => {
        await login(res.token, res.user);
        router.replace('/(app)');
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg || 'Could not connect to server.');
        console.error('Auto-login failed:', e);
      });
  }, [login, loginMutation, retryCount]);

  useEffect(() => {
    if (isLoading) return;
    if (token) { router.replace('/(app)'); return; }
    doLogin();
  }, [isLoading, retryCount]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.primary} animating={!error} />
      {error ? (
        <>
          <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
          <Pressable
            onPress={() => setRetryCount((n) => n + 1)}
            style={[styles.retryBtn, { borderColor: colors.primary }]}
          >
            <Text style={[styles.retryText, { color: colors.primary }]}>Tap to retry</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  error: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32, fontFamily: 'Inter_400Regular' },
  retryBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  retryText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
});
