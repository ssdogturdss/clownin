import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Animated,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import * as Haptics from "expo-haptics";

const IDEAS = [
  { icon: "🌐", label: "A REST API with Express" },
  { icon: "🕷️", label: "A Python web scraper" },
  { icon: "📋", label: "A full-stack todo app" },
  { icon: "📈", label: "A landing page with waitlist" },
];

interface OnboardingScreenProps {
  onSubmit: (idea: string) => void;
  onSkip: () => void;
  isLoading: boolean;
  onBrowseTemplates?: () => void;
  pendingTemplate?: { id: string; name: string } | null;
  assistTemplate?: { id: string; name: string } | null;
  onChangeTemplate?: () => void;
  onProceedWithTemplate?: () => void;
}

const COUNTDOWN_MS = 2000;

export function OnboardingScreen({
  onSubmit,
  onSkip,
  isLoading,
  onBrowseTemplates,
  pendingTemplate,
  assistTemplate,
  onChangeTemplate,
  onProceedWithTemplate,
}: OnboardingScreenProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [idea, setIdea] = useState("");
  const [countdown, setCountdown] = useState(0);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bannerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (pendingTemplate || assistTemplate) {
      // Fade in the banner
      Animated.timing(bannerOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      if (!pendingTemplate) {
        setCountdown(0);
        return;
      }
      // Auto-matched templates proceed after a short confirmation window.
      const startTime = Date.now();
      setCountdown(COUNTDOWN_MS);
      countdownIntervalRef.current = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, COUNTDOWN_MS - elapsed);
        setCountdown(remaining);
        if (remaining === 0 && countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      }, 50);
    } else {
      // Fade out
      Animated.timing(bannerOpacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start();
      setCountdown(0);
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    }
    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [pendingTemplate, assistTemplate]);

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSubmit(trimmed);
  };

  const topPad = Platform.OS === "web" ? 24 : insets.top;
  const bottomPad = Platform.OS === "web" ? 24 : insets.bottom;
  const progressWidth = COUNTDOWN_MS > 0 ? (countdown / COUNTDOWN_MS) * 100 : 0;
  const selectedTemplate = assistTemplate ?? pendingTemplate;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Skip button */}
      <View style={[styles.topBar, { paddingTop: topPad + 8 }]}>
        <Text style={[styles.brand, { color: colors.mutedForeground }]}>Synthetic Solutions</Text>
        <Pressable onPress={onSkip} hitSlop={12} disabled={isLoading}>
          <Text style={[styles.skipLink, { color: colors.mutedForeground }]}>Skip →</Text>
        </Pressable>
      </View>

      {/* Template match notice banner */}
      {selectedTemplate && (
        <Animated.View style={[styles.templateBanner, { backgroundColor: colors.card, borderColor: colors.border, opacity: bannerOpacity }]}>
          <View style={styles.templateBannerRow}>
            <MaterialCommunityIcons name="layers-outline" size={15} color={colors.primary} style={{ marginTop: 1 }} />
            <Text style={[styles.templateBannerText, { color: colors.foreground }]} numberOfLines={1}>
              {assistTemplate ? "Assist with " : "Starting from "}
              <Text style={{ fontFamily: "Inter_600SemiBold" }}>{selectedTemplate.name}</Text>
            </Text>
            <Pressable onPress={onChangeTemplate} hitSlop={8}>
              <Text style={[styles.templateBannerChange, { color: colors.primary }]}>Change</Text>
            </Pressable>
          </View>
          {/* Progress bar showing countdown */}
          {!assistTemplate && <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
            <View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${progressWidth}%` as any }]} />
          </View>}
        </Animated.View>
      )}

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 32 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Text style={styles.emoji}>🤡</Text>
          <Text style={[styles.headline, { color: colors.foreground }]}>
            What do you want{"\n"}to build?
          </Text>
          <Text style={[styles.sub, { color: colors.mutedForeground }]}>
            Describe your idea — the agent writes the code,{"\n"}runs it, and deploys it from your phone.
          </Text>
        </View>

        {/* Idea chips */}
        <View style={styles.chips}>
          {IDEAS.map(({ icon, label }) => (
            <Pressable
              key={label}
              style={({ pressed }) => [
                styles.chip,
                { backgroundColor: colors.card, borderColor: colors.border },
                pressed && { opacity: 0.75 },
              ]}
              onPress={() => handleSubmit(label)}
              disabled={isLoading}
            >
              <Text style={styles.chipIcon}>{icon}</Text>
              <Text style={[styles.chipLabel, { color: colors.foreground }]}>{label}</Text>
              <Text style={[styles.chipArrow, { color: colors.mutedForeground }]}>→</Text>
            </Pressable>
          ))}
        </View>

        {/* Divider */}
        <View style={styles.dividerRow}>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>or type your own</Text>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
        </View>

        {/* Custom input */}
        <View style={[styles.inputBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[styles.input, { color: colors.foreground }]}
            placeholder="Build me a Discord bot that…"
            placeholderTextColor={colors.mutedForeground}
            value={idea}
            onChangeText={setIdea}
            multiline
            maxLength={300}
            editable={!isLoading}
            returnKeyType="done"
          />
        </View>

        <Pressable
          style={[
            styles.buildBtn,
            { backgroundColor: colors.primary, opacity: (!idea.trim() || isLoading) ? 0.5 : 1 },
          ]}
          onPress={() => handleSubmit(idea)}
          disabled={!idea.trim() || isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.buildBtnText}>Build it →</Text>
          )}
        </Pressable>

        {onBrowseTemplates && (
          <Pressable
            style={styles.templateBtn}
            onPress={onBrowseTemplates}
            disabled={isLoading}
          >
            <MaterialCommunityIcons name="view-grid-outline" size={15} color={colors.mutedForeground} />
            <Text style={[styles.templateBtnText, { color: colors.mutedForeground }]}>
              Or start from a template
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  brand: { fontSize: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5 },
  skipLink: { fontSize: 14, fontFamily: "Inter_400Regular" },

  content: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 8,
  },

  hero: { alignItems: "center", paddingVertical: 32, gap: 12 },
  emoji: { fontSize: 64 },
  headline: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    letterSpacing: -0.8,
    lineHeight: 40,
  },
  sub: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
  },

  chips: { gap: 10, marginBottom: 24 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  chipIcon: { fontSize: 20 },
  chipLabel: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium" },
  chipArrow: { fontSize: 16 },

  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  divider: { flex: 1, height: 1 },
  dividerText: { fontSize: 12, fontFamily: "Inter_400Regular" },

  inputBox: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    minHeight: 80,
  },
  input: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    minHeight: 56,
  },

  buildBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  buildBtnText: {
    color: "#fff",
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.2,
  },
  templateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 16,
    paddingVertical: 8,
  },
  templateBtnText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },

  templateBanner: {
    marginHorizontal: 16,
    marginBottom: 4,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  templateBannerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  templateBannerText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  templateBannerChange: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  progressTrack: {
    height: 2,
    width: "100%",
  },
  progressFill: {
    height: 2,
  },
});
