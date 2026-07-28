import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';

export default function RootIndex() {
  const { token, isLoading } = useAuth();
  const colors = useColors();

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
