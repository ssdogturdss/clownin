import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useProfile } from '@/hooks/useProfile';
import { PaywallSheet } from './PaywallSheet';
import { resolveApiBaseUrl } from '@/app/_layout';
import { useRedeemPromoCode, type RedeemPromoCodeResponse } from '@workspace/api-client-react';

interface ProfileModalProps {
  visible: boolean;
  onClose: () => void;
  onLogout: () => void;
}

function getInitials(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

export function ProfileModal({ visible, onClose, onLogout }: ProfileModalProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { data: profile, isLoading, refetch: refetchProfile } = useProfile();
  const [showPaywall, setShowPaywall] = useState(false);
  const [showPromoInput, setShowPromoInput] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const { mutate: redeemCode, isPending: isRedeeming } = useRedeemPromoCode({
    mutation: {
      onSuccess: (data: RedeemPromoCodeResponse) => {
        setPromoCode('');
        setShowPromoInput(false);
        refetchProfile();
        Alert.alert('🎉 Success!', data.message);
      },
      onError: (error: any) => {
        const msg = error?.response?.data?.error ?? error?.message ?? 'Failed to redeem code';
        Alert.alert('Invalid Code', msg);
      },
    },
  });

  const bottomPad = Platform.OS === 'ios' ? insets.bottom + 20 : 28;

  const isPro = profile?.subscriptionTier === 'pro';
  const used = profile?.dailyMessageCount ?? 0;
  const limit = profile?.dailyMessageLimit ?? 20;
  const usagePercent = Math.min(used / limit, 1);

  const handleLogout = () => {
    onClose();
    Alert.alert('Sign Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: onLogout },
    ]);
  };

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <Pressable style={styles.overlay} onPress={onClose}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: bottomPad }]}
            onPress={(e) => e.stopPropagation()}
          >
            {/* Drag handle */}
            <View style={[styles.handle, { backgroundColor: colors.border }]} />

            {/* Close */}
            <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={colors.mutedForeground} />
            </Pressable>

            {isLoading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <>
                {/* Avatar */}
                <View style={[styles.avatar, { backgroundColor: colors.primary + '22', borderColor: colors.primary + '44' }]}>
                  <Text style={[styles.avatarText, { color: colors.primary }]}>
                    {getInitials(profile?.username ?? '??')}
                  </Text>
                </View>

                {/* Name + badge */}
                <View style={styles.nameRow}>
                  <Text style={[styles.username, { color: colors.foreground }]}>
                    @{profile?.username}
                  </Text>
                  <View style={[
                    styles.planBadge,
                    isPro
                      ? { backgroundColor: '#f59e0b22', borderColor: '#f59e0b55' }
                      : { backgroundColor: colors.secondary, borderColor: colors.border },
                  ]}>
                    <Text style={[
                      styles.planBadgeText,
                      { color: isPro ? '#f59e0b' : colors.mutedForeground },
                    ]}>
                      {isPro ? '✦ PRO' : 'FREE'}
                    </Text>
                  </View>
                </View>

                <Text style={[styles.email, { color: colors.mutedForeground }]}>
                  {profile?.email}
                </Text>

                {/* Usage section (free tier only) */}
                {!isPro && (
                  <View style={[styles.usageCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
                    <View style={styles.usageHeader}>
                      <Text style={[styles.usageLabel, { color: colors.foreground }]}>AI messages today</Text>
                      <Text style={[styles.usageCount, { color: used >= limit ? colors.destructive : colors.primary }]}>
                        {used} / {limit}
                      </Text>
                    </View>
                    <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            width: `${usagePercent * 100}%`,
                            backgroundColor: usagePercent >= 1 ? colors.destructive : colors.primary,
                          },
                        ]}
                      />
                    </View>
                    {used >= limit && (
                      <Text style={[styles.usageWarning, { color: colors.destructive }]}>
                        Daily limit reached — resets at midnight UTC
                      </Text>
                    )}
                  </View>
                )}

                {/* Upgrade button (free tier only) */}
                {!isPro && (
                  <Pressable
                    style={({ pressed }) => [
                      styles.upgradeBtn,
                      { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
                    ]}
                    onPress={() => {
                      onClose();
                      setTimeout(() => setShowPaywall(true), 300);
                    }}
                  >
                    <Text style={[styles.upgradeBtnText, { color: colors.primaryForeground }]}>
                      🚀 Upgrade to Pro
                    </Text>
                  </Pressable>
                )}

                {/* Promo code section (free tier only) */}
                {!isPro && (
                  showPromoInput ? (
                    <View style={[styles.promoInputWrap, { borderColor: colors.border, backgroundColor: colors.background }]}>
                      <TextInput
                        style={[styles.promoInput, { color: colors.foreground }]}
                        placeholder="CLOWN-XXXXXX-XXXXXX"
                        placeholderTextColor={colors.mutedForeground}
                        value={promoCode}
                        onChangeText={(t) => setPromoCode(t.toUpperCase())}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        editable={!isRedeeming}
                      />
                      <View style={styles.promoActions}>
                        <Pressable
                          style={({ pressed }) => [
                            styles.promoCancelBtn,
                            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                          ]}
                          onPress={() => { setShowPromoInput(false); setPromoCode(''); }}
                          disabled={isRedeeming}
                        >
                          <Text style={[styles.promoCancelText, { color: colors.mutedForeground }]}>Cancel</Text>
                        </Pressable>
                        <Pressable
                          style={({ pressed }) => [
                            styles.promoRedeemBtn,
                            { backgroundColor: colors.primary, opacity: (pressed || isRedeeming || !promoCode.trim()) ? 0.6 : 1 },
                          ]}
                          onPress={() => redeemCode({ data: { code: promoCode.trim() } })}
                          disabled={isRedeeming || !promoCode.trim()}
                        >
                          {isRedeeming
                            ? <ActivityIndicator size="small" color={colors.primaryForeground} />
                            : <Text style={[styles.promoRedeemText, { color: colors.primaryForeground }]}>Redeem</Text>
                          }
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <Pressable onPress={() => setShowPromoInput(true)}>
                      <Text style={[styles.promoLink, { color: colors.mutedForeground }]}>
                        Have a promo code?
                      </Text>
                    </Pressable>
                  )
                )}

                {/* Secrets vault */}
                <Pressable
                  style={({ pressed }) => [
                    styles.vaultBtn,
                    { borderColor: colors.border, backgroundColor: pressed ? colors.secondary : 'transparent' },
                  ]}
                  onPress={() => { onClose(); router.push('/(app)/secrets'); }}
                >
                  <Ionicons name="shield-outline" size={16} color={colors.foreground} />
                  <Text style={[styles.vaultBtnText, { color: colors.foreground }]}>Secrets vault</Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.mutedForeground} />
                </Pressable>

                {/* Divider */}
                <View style={[styles.divider, { backgroundColor: colors.border }]} />

                {/* Legal links */}
                <View style={styles.legalRow}>
                  <Pressable
                    style={styles.legalBtn}
                    onPress={() => {
                      const base = resolveApiBaseUrl() ?? '';
                      WebBrowser.openBrowserAsync(`${base}/api/privacy`);
                    }}
                  >
                    <Ionicons name="shield-checkmark-outline" size={16} color={colors.mutedForeground} />
                    <Text style={[styles.legalText, { color: colors.mutedForeground }]}>Privacy Policy</Text>
                  </Pressable>
                  <Text style={[styles.legalSeparator, { color: colors.border }]}>·</Text>
                  <Pressable
                    style={styles.legalBtn}
                    onPress={() => {
                      const base = resolveApiBaseUrl() ?? '';
                      WebBrowser.openBrowserAsync(`${base}/api/terms`);
                    }}
                  >
                    <Ionicons name="document-text-outline" size={16} color={colors.mutedForeground} />
                    <Text style={[styles.legalText, { color: colors.mutedForeground }]}>Terms of Service</Text>
                  </Pressable>
                </View>

                {/* Sign out */}
                <Pressable style={styles.signOutBtn} onPress={handleLogout}>
                  <Ionicons name="log-out-outline" size={18} color={colors.destructive} />
                  <Text style={[styles.signOutText, { color: colors.destructive }]}>Sign Out</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <PaywallSheet
        visible={showPaywall}
        onClose={() => setShowPaywall(false)}
        reason="daily_limit"
      />
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 24,
    paddingTop: 12,
    alignItems: 'center',
    gap: 10,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 4,
  },
  closeBtn: {
    position: 'absolute',
    top: 16,
    right: 20,
    padding: 4,
  },
  loadingWrap: {
    paddingVertical: 40,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  avatarText: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  username: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.3,
  },
  planBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  planBadgeText: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  email: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    marginTop: -4,
  },
  usageCard: {
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
    marginTop: 4,
  },
  usageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  usageLabel: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  usageCount: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  usageWarning: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  upgradeBtn: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  upgradeBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  divider: {
    width: '100%',
    height: 1,
    marginVertical: 4,
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  legalText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  legalSeparator: {
    fontSize: 16,
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  signOutText: {
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
  },
  promoLink: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textDecorationLine: 'underline',
    paddingVertical: 2,
  },
  promoInputWrap: {
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  promoInput: {
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
    letterSpacing: 1,
    paddingVertical: 4,
  },
  promoActions: {
    flexDirection: 'row',
    gap: 8,
  },
  promoCancelBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  promoCancelText: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  promoRedeemBtn: {
    flex: 2,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  promoRedeemText: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  vaultBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 4,
  },
  vaultBtnText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
});
