import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { useLogin } from '@workspace/api-client-react';

export default function RootIndex() {
  const { token, isLoading, login } = useAuth();
  const colors = useColors();
  const loginMutation = useLogin();
  const [error, setError] = useState('');

  useEffect(() => {
    if (isLoading) return;

    if (token) {
      router.replace('/(app)');
      return;
    }

    // Auto-login with demo account — no login screen needed
    loginMutation
      .mutateAsync({ data: { email: 'demo@clownin.dev', password: 'demo1234' } })
      .then(async (res) => {
        await login(res.token, res.user);
        router.replace('/(app)');
      })
      .catch((e) => {
        setError('Could not connect to server. Is the API running?');
        console.error('Auto-login failed:', e);
      });
  }, [isLoading]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.primary} />
      {error ? (
        <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  error: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32, fontFamily: 'Inter_400Regular' },
});
