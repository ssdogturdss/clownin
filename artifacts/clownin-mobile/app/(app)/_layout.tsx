import { Stack } from 'expo-router';
import { useColors } from '@/hooks/useColors';

export default function AppLayout() {
  const colors = useColors();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: 'transparent' },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen
        name="project/[id]"
        options={{ animation: 'slide_from_right', gestureEnabled: true }}
      />
      <Stack.Screen
        name="servers"
        options={{ animation: 'slide_from_right', gestureEnabled: true }}
      />
      <Stack.Screen
        name="project-env"
        options={{ animation: 'slide_from_right', gestureEnabled: true }}
      />
      <Stack.Screen
        name="templates"
        options={{ animation: 'slide_from_right', gestureEnabled: true }}
      />
      <Stack.Screen
        name="secrets"
        options={{ animation: 'slide_from_right', gestureEnabled: true }}
      />
      <Stack.Screen
        name="admin"
        options={{ animation: 'slide_from_right', gestureEnabled: true }}
      />
    </Stack>
  );
}
