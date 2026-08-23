import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';

/**
 * Root entry point — waits for auth hydration to complete before routing.
 *
 * Staying on this screen (showing a spinner) while `isLoading` is true
 * prevents any authenticated query from firing before we know whether a stored
 * token exists, which avoids 401 responses being cached by React Query.
 */
export default function RootIndex() {
  const colors = useColors();
  const { token, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (token) {
      router.replace('/(app)');
    } else {
      router.replace('/(auth)/login');
    }
  }, [token, isLoading]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
