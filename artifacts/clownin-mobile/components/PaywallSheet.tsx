import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useSubscription } from '@/lib/revenuecat';

export type PaywallReason = 'daily_limit' | 'project_limit';

interface PaywallSheetProps {
  visible: boolean;
  onClose: () => void;
  reason?: PaywallReason;
}

const PRO_FEATURES = [
  { icon: 'infinity' as const,               label: 'Unlimited AI messages per day' },
  { icon: 'folder-multiple-outline' as const, label: 'Unlimited projects' },
  { icon: 'lightning-bolt' as const,          label: 'Priority AI responses' },
  { icon: 'star-outline' as const,            label: 'Early access to new features' },
];

export function PaywallSheet({ visible, onClose, reason = 'daily_limit' }: PaywallSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    monthlyPackage,
    priceString,
    isSubscribed,
    isPurchasing,
    purchase,
    restore,
    isRestoring,
    purchaseError,
  } = useSubscription();

  const [localError, setLocalError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  // Auto-close if already subscribed (purchase succeeded)
  React.useEffect(() => {
    if (isSubscribed && visible) onClose();
  }, [isSubscribed, visible, onClose]);

  const headline =
    reason === 'project_limit'
      ? "You've reached your project limit"
      : "You've used all your messages today";

  const subtext =
    reason === 'project_limit'
      ? 'Free accounts can have up to 3 projects. Upgrade for unlimited.'
      : 'Free accounts get 20 AI messages per day. Upgrade for unlimited.';

  const bottomPad = Platform.OS === 'ios' ? insets.bottom + 20 : 28;

  const handleSubscribe = async () => {
    if (!monthlyPackage) {
      setLocalError('Store not available right now. Please try again shortly.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // In __DEV__ show a confirm so testers can cancel without triggering a purchase
    if (__DEV__) {
      setShowConfirm(true);
      return;
    }
    await doPurchase();
  };

  const doPurchase = async () => {
    setLocalError('');
    setShowConfirm(false);
    try {
      await purchase(monthlyPackage!);
    } catch (err: unknown) {
      // USER_CANCELLED is not an error — just dismiss silently
      if (err && typeof err === 'object' && 'userCancelled' in err) return;
      setLocalError(err instanceof Error ? err.message : 'Purchase failed. Please try again.');
    }
  };

  const handleRestore = async () => {
    setLocalError('');
    try {
      await restore();
    } catch {
      setLocalError('Could not restore purchases. Please try again.');
    }
  };

  const errorMsg = localError || (purchaseError instanceof Error ? purchaseError.message : '');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Dev-mode purchase confirm */}
      {showConfirm && (
        <Modal visible transparent animationType="fade">
          <Pressable style={styles.confirmOverlay} onPress={() => setShowConfirm(false)}>
            <Pressable
              style={[styles.confirmBox, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={(e) => e.stopPropagation()}
            >
              <Text style={[styles.confirmTitle, { color: colors.foreground }]}>
                Test Purchase
              </Text>
              <Text style={[styles.confirmBody, { color: colors.mutedForeground }]}>
                You're in development mode. This will trigger a RevenueCat Test Store purchase. Proceed?
              </Text>
              <View style={styles.confirmRow}>
                <Pressable
                  style={[styles.confirmBtn, { borderColor: colors.border }]}
                  onPress={() => setShowConfirm(false)}
                >
                  <Text style={[styles.confirmBtnText, { color: colors.mutedForeground }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.confirmBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={doPurchase}
                >
                  <Text style={[styles.confirmBtnText, { color: '#fff' }]}>Purchase</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

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

          {/* Hero */}
          <Text style={styles.emoji}>🚀</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>Upgrade to Pro</Text>
          <Text style={[styles.headline, { color: colors.foreground }]}>{headline}</Text>
          <Text style={[styles.subtext, { color: colors.mutedForeground }]}>{subtext}</Text>

          {/* Features */}
          <View style={[styles.featureCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
            {PRO_FEATURES.map((f) => (
              <View key={f.label} style={styles.featureRow}>
                <MaterialCommunityIcons name={f.icon} size={18} color={colors.primary} />
                <Text style={[styles.featureText, { color: colors.foreground }]}>{f.label}</Text>
              </View>
            ))}
          </View>

          {/* Price — live from RevenueCat */}
          <View style={styles.priceRow}>
            <Text style={[styles.priceAmount, { color: colors.foreground }]}>{priceString}</Text>
            <Text style={[styles.pricePeriod, { color: colors.mutedForeground }]}> / month</Text>
          </View>

          {/* Error */}
          {errorMsg ? (
            <Text style={[styles.error, { color: colors.destructive }]}>{errorMsg}</Text>
          ) : null}

          {/* CTA */}
          <Pressable
            style={({ pressed }) => [
              styles.subscribeBtn,
              { backgroundColor: colors.primary, opacity: pressed || isPurchasing ? 0.75 : 1 },
            ]}
            onPress={handleSubscribe}
            disabled={isPurchasing}
          >
            {isPurchasing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialCommunityIcons name="crown-outline" size={18} color={colors.primaryForeground} />
            )}
            <Text style={[styles.subscribeBtnText, { color: colors.primaryForeground }]}>
              {isPurchasing ? 'Processing…' : 'Subscribe Now'}
            </Text>
          </Pressable>

          {/* Restore */}
          <Pressable onPress={handleRestore} disabled={isRestoring} style={styles.restoreRow}>
            <Text style={[styles.restoreText, { color: colors.mutedForeground }]}>
              {isRestoring ? 'Restoring…' : 'Restore purchases'}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
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
    gap: 8,
  },
  handle: { width: 36, height: 4, borderRadius: 2, marginBottom: 4 },
  closeBtn: { position: 'absolute', top: 16, right: 20, padding: 4 },
  emoji: { fontSize: 44, marginTop: 8 },
  title: { fontSize: 24, fontFamily: 'Inter_700Bold', letterSpacing: -0.3, marginTop: 4 },
  headline: { fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'center', marginTop: 4 },
  subtext: {
    fontSize: 14, fontFamily: 'Inter_400Regular',
    textAlign: 'center', lineHeight: 20, marginBottom: 4,
  },
  featureCard: {
    width: '100%', borderRadius: 14, borderWidth: 1,
    padding: 16, gap: 12, marginVertical: 4,
  },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  featureText: { fontSize: 14, fontFamily: 'Inter_400Regular', flex: 1 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 4 },
  priceAmount: { fontSize: 32, fontFamily: 'Inter_700Bold' },
  pricePeriod: { fontSize: 16, fontFamily: 'Inter_400Regular' },
  error: { fontSize: 13, textAlign: 'center', marginTop: 2 },
  subscribeBtn: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, paddingVertical: 16,
    borderRadius: 14, marginTop: 4,
  },
  subscribeBtnText: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  restoreRow: { paddingVertical: 4 },
  restoreText: { fontSize: 12, fontFamily: 'Inter_400Regular', textDecorationLine: 'underline' },

  // Dev confirm dialog
  confirmOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  confirmBox: {
    width: '100%', borderRadius: 16, borderWidth: 1,
    padding: 24, gap: 12,
  },
  confirmTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  confirmBody: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  confirmRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  confirmBtn: {
    flex: 1, borderWidth: 1, borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  confirmBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});
