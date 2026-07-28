import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ActivityIndicator,
  ScrollView,
  Linking,
  StyleSheet,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";
import { resolveApiBaseUrl } from "@/app/_layout";

interface DeployModalProps {
  visible: boolean;
  onClose: () => void;
  projectId: number;
  projectName: string;
}

type Platform = "netlify" | "vercel";

const PLATFORMS: Array<{
  id: Platform;
  label: string;
  icon: string;
  color: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenUrl: string;
  desc: string;
}> = [
  {
    id: "netlify",
    label: "Netlify",
    icon: "triangle",
    color: "#00C7B7",
    tokenLabel: "Netlify Personal Access Token",
    tokenPlaceholder: "nfp_xxxxxxxxxxxx",
    tokenUrl: "https://app.netlify.com/user/applications#personal-access-tokens",
    desc: "Free tier · instant HTTPS · great for static & Node",
  },
  {
    id: "vercel",
    label: "Vercel",
    icon: "triangle-outline",
    color: "#fff",
    tokenLabel: "Vercel Access Token",
    tokenPlaceholder: "xxxxxxxxxxxxxxxxxxxx",
    tokenUrl: "https://vercel.com/account/tokens",
    desc: "Free tier · global CDN · auto-detects framework",
  },
];

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
}

export function DeployModal({ visible, onClose, projectId, projectName }: DeployModalProps) {
  const colors = useColors();
  const { token } = useAuth();
  const s = makeStyles(colors);

  const [platform, setPlatform] = useState<Platform>("netlify");
  const [tokens, setTokens] = useState<Record<Platform, string>>({ netlify: "", vercel: "" });
  const [name, setName] = useState(slugify(projectName));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ url: string; platform: Platform; warning?: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setName(slugify(projectName));
    setResult(null);
    setError("");
    // Load saved tokens
    Promise.all([
      AsyncStorage.getItem("clownin_netlify_token"),
      AsyncStorage.getItem("clownin_vercel_token"),
    ]).then(([nt, vt]) => {
      setTokens({ netlify: nt ?? "", vercel: vt ?? "" });
    });
  }, [visible, projectName]);

  const currentPlatform = PLATFORMS.find((p) => p.id === platform)!;
  const currentToken = tokens[platform];

  const handleDeploy = async () => {
    if (!currentToken.trim()) { setError(`Enter your ${currentPlatform.label} token`); return; }
    setLoading(true);
    setError("");

    // Save token
    await AsyncStorage.setItem(`clownin_${platform}_token`, currentToken.trim());

    try {
      const baseUrl = resolveApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/deploy/${platform}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          token: currentToken.trim(),
          siteName: name.trim(),
          projectName: name.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deploy failed");
      setResult({ url: data.url, platform, warning: data.warning });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={s.header}>
            <MaterialCommunityIcons name="rocket-launch-outline" size={22} color={colors.primary} />
            <Text style={s.title}>Deploy</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <MaterialCommunityIcons name="close" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView style={s.body} keyboardShouldPersistTaps="handled">
            {result ? (
              /* ── Success ── */
              <View style={s.success}>
                <Text style={s.successEmoji}>🚀</Text>
                <Text style={s.successTitle}>Live!</Text>
                <Pressable onPress={() => Linking.openURL(result.url)}>
                  <Text style={[s.successUrl, { color: colors.info }]}>{result.url}</Text>
                </Pressable>
                {result.warning ? (
                  <Text style={[s.deployWarning, { color: colors.warning ?? "#f59e0b", borderColor: colors.border }]}>
                    ⚠️ {result.warning}
                  </Text>
                ) : null}
                <Pressable
                  style={[s.openBtn, { backgroundColor: colors.primary }]}
                  onPress={() => Linking.openURL(result.url)}
                >
                  <MaterialCommunityIcons name="open-in-new" size={16} color="#fff" />
                  <Text style={s.openBtnText}>Open App</Text>
                </Pressable>
                <Pressable onPress={() => setResult(null)}>
                  <Text style={[s.deployAgainText, { color: colors.mutedForeground }]}>Deploy again</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {/* Platform picker */}
                <View style={s.platformRow}>
                  {PLATFORMS.map((p) => (
                    <Pressable
                      key={p.id}
                      style={[
                        s.platformBtn,
                        {
                          backgroundColor: platform === p.id ? colors.card : "transparent",
                          borderColor: platform === p.id ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() => { setPlatform(p.id); setError(""); }}
                    >
                      <MaterialCommunityIcons
                        name={p.icon as never}
                        size={18}
                        color={platform === p.id ? p.color : colors.mutedForeground}
                      />
                      <Text style={[s.platformLabel, { color: platform === p.id ? colors.foreground : colors.mutedForeground }]}>
                        {p.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={[s.platformDesc, { color: colors.mutedForeground }]}>{currentPlatform.desc}</Text>

                {/* Token */}
                <Text style={s.label}>{currentPlatform.tokenLabel}</Text>
                <TextInput
                  style={s.input}
                  placeholder={currentPlatform.tokenPlaceholder}
                  placeholderTextColor={colors.mutedForeground}
                  value={currentToken}
                  onChangeText={(t) => setTokens((prev) => ({ ...prev, [platform]: t }))}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={s.hint}>
                  <Text style={{ color: colors.info }} onPress={() => Linking.openURL(currentPlatform.tokenUrl)}>
                    Get a token →
                  </Text>
                </Text>

                {/* Site/project name */}
                <Text style={s.label}>Site Name</Text>
                <TextInput
                  style={s.input}
                  value={name}
                  onChangeText={(t) => setName(slugify(t))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholderTextColor={colors.mutedForeground}
                />

                {error ? <Text style={s.error}>{error}</Text> : null}

                <Pressable
                  style={[s.deployBtn, { backgroundColor: colors.primary, opacity: loading ? 0.6 : 1 }]}
                  onPress={handleDeploy}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={s.deployBtnText}>Deploying…</Text>
                    </>
                  ) : (
                    <>
                      <MaterialCommunityIcons name="rocket-launch" size={18} color="#fff" />
                      <Text style={s.deployBtnText}>Deploy to {currentPlatform.label}</Text>
                    </>
                  )}
                </Pressable>

                <Text style={[s.fineprint, { color: colors.mutedForeground }]}>
                  Your token is saved locally and only sent to {currentPlatform.label}'s API.
                </Text>
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      maxHeight: "82%",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.foreground },
    body: { padding: 16 },
    platformRow: { flexDirection: "row", gap: 10, marginBottom: 8 },
    platformBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: 10,
    },
    platformLabel: { fontSize: 14, fontWeight: "600" },
    platformDesc: { fontSize: 12, marginBottom: 4 },
    label: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 14,
      marginBottom: 6,
    },
    input: {
      backgroundColor: colors.input,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.foreground,
      fontSize: 14,
    },
    hint: { fontSize: 12, marginTop: 4 },
    error: { color: colors.destructive, fontSize: 13, marginTop: 10, textAlign: "center" },
    deployBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 18,
    },
    deployBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    fineprint: { fontSize: 11, textAlign: "center", marginTop: 10, marginBottom: 4, lineHeight: 16 },
    // Success
    success: { alignItems: "center", paddingVertical: 32, gap: 14 },
    successEmoji: { fontSize: 52 },
    successTitle: { fontSize: 24, fontWeight: "800", color: colors.foreground },
    successUrl: { fontSize: 13, textDecorationLine: "underline", textAlign: "center" },
    openBtn: {
      flexDirection: "row", alignItems: "center", gap: 8,
      paddingHorizontal: 24, paddingVertical: 13, borderRadius: 12,
    },
    openBtnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
    deployAgainText: { fontSize: 13, marginTop: 4 },
    deployWarning: {
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      marginHorizontal: 4,
    },
  });
}
