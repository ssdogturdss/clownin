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
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useLogin } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const loginMutation = useLogin();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required');
      return;
    }
    setError('');
    try {
      const res = await loginMutation.mutateAsync({ data: { email: email.trim(), password } });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await login(res.token, res.user);
      router.replace('/(app)');
    } catch (e: unknown) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (e && typeof e === 'object' && 'data' in e) {
        const apiErr = e as { data?: { error?: string } };
        setError(apiErr.data?.error ?? 'Login failed');
      } else {
        setError('Login failed. Check your connection.');
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
      {/* Logo area */}
      <View style={styles.logoArea}>
        <Text style={styles.logoText}>Synthetic Solutions</Text>
        <Text style={styles.logoSub}>Clownin Edition</Text>
      </View>

      {/* Form */}
      <View style={styles.form}>
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
          placeholder="Password"
          placeholderTextColor={colors.mutedForeground}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          returnKeyType="done"
          onSubmitEditing={handleLogin}
        />

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          onPress={handleLogin}
          disabled={loginMutation.isPending}
        >
          {loginMutation.isPending ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.primaryBtnText}>Sign In</Text>
          )}
        </Pressable>

        {/* Demo hint */}
        <Pressable onPress={() => { setEmail('demo@clownin.dev'); setPassword('demo1234'); }}>
          <Text style={styles.demoText}>Use demo account</Text>
        </Pressable>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>Don&apos;t have an account?</Text>
        <Pressable onPress={() => router.push('/(auth)/register')}>
          <Text style={styles.linkText}> Sign Up</Text>
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
    logoArea: { alignItems: 'center', marginBottom: 48 },
    logoText: {
      fontSize: 42,
      fontFamily: 'Inter_700Bold',
      color: colors.primary,
      letterSpacing: -1,
    },
    logoSub: {
      fontSize: 14,
      fontFamily: 'Inter_400Regular',
      color: colors.mutedForeground,
      marginTop: 4,
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
    demoText: {
      color: colors.mutedForeground,
      fontSize: 13,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
      marginTop: 8,
      textDecorationLine: 'underline',
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
