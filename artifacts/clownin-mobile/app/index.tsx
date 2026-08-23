import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';

// Auth is disabled — go straight to the app, no login screen.
export default function RootIndex() {
  const colors = useColors();

  useEffect(() => {
    router.replace('/(app)');
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
