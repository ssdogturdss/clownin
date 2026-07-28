import { Stack } from 'expo-router';
import { useColors } from '@/hooks/useColors';

export default function AppLayout() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen
        name="project/[id]"
        options={{ animation: 'slide_from_right', gestureEnabled: true }}
      />
    </Stack>
  );
}
