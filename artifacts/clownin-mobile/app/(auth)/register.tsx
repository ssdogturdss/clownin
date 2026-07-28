import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useRegister } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function RegisterScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const registerMutation = useRegister();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleRegister = async () => {
    if (!username.trim() || !email.trim() || !password.trim()) {
      setError('All fields are required');
      return;
    }
    if (username.trim().length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setError('');
    try {
      const res = await registerMutation.mutateAsync({
        data: { username: username.trim(), email: email.trim(), password },
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await login(res.token, res.user);
      router.replace('/(app)');
    } catch (e: unknown) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (e && typeof e === 'object' && 'data' in e) {
        const apiErr = e as { data?: { error?: string } };
        setError(apiErr.data?.error ?? 'Registration failed');
      } else {
        setError('Registration failed. Check your connection.');
      }
    }
  };

  const styles = createStyles(colors, insets);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Text style={styles.title}>Join Clownin</Text>
        <Text style={styles.subtitle}>Start coding in seconds</Text>
      </View>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="Username"
          placeholderTextColor={colors.mutedForeground}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
        />
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.mutedForeground}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
        />
        <TextInput
          style={styles.input}
          placeholder="Password (min 6 chars)"
          placeholderTextColor={colors.mutedForeground}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          returnKeyType="done"
          onSubmitEditing={handleRegister}
        />

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          onPress={handleRegister}
          disabled={registerMutation.isPending}
        >
          {registerMutation.isPending ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.primaryBtnText}>Create Account</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Already have an account?</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.linkText}> Sign In</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function createStyles(colors: ReturnType<typeof useColors>, insets: ReturnType<typeof useSafeAreaInsets>) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: colors.background },
    container: {
      flexGrow: 1,
      paddingHorizontal: 28,
      paddingTop: Platform.OS === 'web' ? 67 + 24 : 40,
      paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 24,
      justifyContent: 'center',
    },
    header: { marginBottom: 40 },
    title: {
      fontSize: 32,
      fontFamily: 'Inter_700Bold',
      color: colors.foreground,
      letterSpacing: -0.5,
    },
    subtitle: {
      fontSize: 15,
      fontFamily: 'Inter_400Regular',
      color: colors.mutedForeground,
      marginTop: 6,
    },
    form: { gap: 12 },
    input: {
      backgroundColor: colors.input,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: colors.radius as number,
      paddingHorizontal: 16,
      paddingVertical: 14,
      fontSize: 16,
      fontFamily: 'Inter_400Regular',
      color: colors.foreground,
    },
    errorText: {
      color: colors.destructive,
      fontSize: 13,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
    },
    primaryBtn: {
      backgroundColor: colors.primary,
      borderRadius: colors.radius as number,
      paddingVertical: 15,
      alignItems: 'center',
      marginTop: 8,
    },
    pressed: { opacity: 0.85 },
    primaryBtnText: {
      color: colors.primaryForeground,
      fontSize: 16,
      fontFamily: 'Inter_600SemiBold',
    },
    footer: {
      flexDirection: 'row',
      justifyContent: 'center',
      marginTop: 32,
    },
    footerText: {
      color: colors.mutedForeground,
      fontSize: 14,
      fontFamily: 'Inter_400Regular',
    },
    linkText: {
      color: colors.primary,
      fontSize: 14,
      fontFamily: 'Inter_600SemiBold',
    },
  });
}
