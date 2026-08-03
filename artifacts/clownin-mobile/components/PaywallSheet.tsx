import React from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';

export type PaywallReason = 'daily_limit' | 'project_limit';

interface PaywallSheetProps {
  visible: boolean;
  onClose: () => void;
  reason?: PaywallReason;
}

const PRO_FEATURES = [
  { icon: 'infinity' as const, label: 'Unlimited AI messages per day' },
  { icon: 'folder-multiple-outline' as const, label: 'Unlimited projects' },
  { icon: 'lightning-bolt' as const, label: 'Priority AI responses' },
  { icon: 'star-outline' as const, label: 'Early access to new features' },
];

export function PaywallSheet({ visible, onClose, reason = 'daily_limit' }: PaywallSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const headline =
    reason === 'project_limit'
      ? "You've reached your project limit"
      : "You've used all your messages today";

  const subtext =
    reason === 'project_limit'
      ? 'Free accounts can have up to 3 projects. Upgrade for unlimited.'
      : 'Free accounts get 20 AI messages per day. Upgrade for unlimited.';

  const bottomPad = Platform.OS === 'ios' ? insets.bottom + 20 : 28;

  return (
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

          {/* Hero */}
          <Text style={styles.emoji}>🚀</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>Upgrade to Pro</Text>
          <Text style={[styles.headline, { color: colors.foreground }]}>{headline}</Text>
          <Text style={[styles.subtext, { color: colors.mutedForeground }]}>{subtext}</Text>

          {/* Features list */}
          <View style={[styles.featureCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
            {PRO_FEATURES.map((f) => (
              <View key={f.label} style={styles.featureRow}>
                <MaterialCommunityIcons name={f.icon} size={18} color={colors.primary} />
                <Text style={[styles.featureText, { color: colors.foreground }]}>{f.label}</Text>
              </View>
            ))}
          </View>

          {/* Price */}
          <View style={styles.priceRow}>
            <Text style={[styles.priceAmount, { color: colors.foreground }]}>$9.99</Text>
            <Text style={[styles.pricePeriod, { color: colors.mutedForeground }]}> / month</Text>
          </View>

          {/* CTA — subscribe button (stub until App Store is live) */}
          <Pressable
            style={({ pressed }) => [
              styles.subscribeBtn,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            }}
          >
            <MaterialCommunityIcons name="crown-outline" size={18} color={colors.primaryForeground} />
            <Text style={[styles.subscribeBtnText, { color: colors.primaryForeground }]}>
              Coming Soon on App Stores
            </Text>
          </Pressable>

          <Text style={[styles.footnote, { color: colors.mutedForeground }]}>
            Subscriptions will be available when published to the App Store and Google Play.
          </Text>
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
  emoji: {
    fontSize: 44,
    marginTop: 8,
  },
  title: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.3,
    marginTop: 4,
  },
  headline: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'center',
    marginTop: 4,
  },
  subtext: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 4,
  },
  featureCard: {
    width: '100%',
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 12,
    marginVertical: 4,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  featureText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    flex: 1,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 4,
  },
  priceAmount: {
    fontSize: 32,
    fontFamily: 'Inter_700Bold',
  },
  pricePeriod: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
  },
  subscribeBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 4,
  },
  subscribeBtnText: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  footnote: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 4,
  },
});
