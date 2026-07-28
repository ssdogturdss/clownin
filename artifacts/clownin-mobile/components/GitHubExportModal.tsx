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
  Switch,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";
import { resolveApiBaseUrl } from "@/app/_layout";

interface GitHubExportModalProps {
  visible: boolean;
  onClose: () => void;
  projectId: number;
  projectName: string;
}

const TOKEN_KEY = "clownin_gh_token";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

export function GitHubExportModal({
  visible,
  onClose,
  projectId,
  projectName,
}: GitHubExportModalProps) {
  const colors = useColors();
  const { token } = useAuth();

  const [ghToken, setGhToken] = useState("");
  const [repoName, setRepoName] = useState(slugify(projectName));
  const [isPrivate, setIsPrivate] = useState(false);
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ repoUrl: string; owner: string } | null>(null);
  const [error, setError] = useState("");

  // Load saved token
  useEffect(() => {
    if (visible) {
      AsyncStorage.getItem(TOKEN_KEY).then((t) => { if (t) setGhToken(t); });
      setRepoName(slugify(projectName));
      setResult(null);
      setError("");
    }
  }, [visible, projectName]);

  const handlePush = async () => {
    if (!ghToken.trim()) { setError("Enter your GitHub token"); return; }
    if (!repoName.trim()) { setError("Enter a repo name"); return; }
    setLoading(true);
    setError("");

    try {
      // Save token for next time
      await AsyncStorage.setItem(TOKEN_KEY, ghToken.trim());

      const baseUrl = resolveApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/github/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          token: ghToken.trim(),
          repoName: repoName.trim(),
          isPrivate,
          description: description.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Push failed");
      setResult(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Push failed");
    } finally {
      setLoading(false);
    }
  };

  const s = makeStyles(colors);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={s.header}>
            <MaterialCommunityIcons name="github" size={22} color={colors.foreground} />
            <Text style={s.title}>Push to GitHub</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <MaterialCommunityIcons name="close" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView style={s.body} keyboardShouldPersistTaps="handled">
            {result ? (
              /* ── Success state ── */
              <View style={s.success}>
                <Text style={s.successEmoji}>🎉</Text>
                <Text style={s.successTitle}>Pushed to GitHub!</Text>
                <Text style={s.successUrl}>{result.repoUrl}</Text>
                <Pressable
                  style={[s.openBtn, { backgroundColor: colors.primary }]}
                  onPress={() => Linking.openURL(result.repoUrl)}
                >
                  <MaterialCommunityIcons name="open-in-new" size={16} color="#fff" />
                  <Text style={s.openBtnText}>Open Repo</Text>
                </Pressable>
                <Text style={s.deployHint}>
                  Connect this repo to Vercel, Railway, or Render to deploy it live in one click.
                </Text>
              </View>
            ) : (
              /* ── Form ── */
              <>
                <Text style={s.label}>GitHub Token</Text>
                <TextInput
                  style={s.input}
                  placeholder="ghp_xxxxxxxxxxxx"
                  placeholderTextColor={colors.mutedForeground}
                  value={ghToken}
                  onChangeText={setGhToken}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={s.hint}>
                  Need a token?{" "}
                  <Text
                    style={{ color: colors.info }}
                    onPress={() =>
                      Linking.openURL(
                        "https://github.com/settings/tokens/new?scopes=repo&description=Clownin"
                      )
                    }
                  >
                    Create one here
                  </Text>{" "}
                  (repo scope required)
                </Text>

                <Text style={s.label}>Repository Name</Text>
                <TextInput
                  style={s.input}
                  placeholder="my-project"
                  placeholderTextColor={colors.mutedForeground}
                  value={repoName}
                  onChangeText={(t) => setRepoName(slugify(t))}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <Text style={s.label}>Description (optional)</Text>
                <TextInput
                  style={s.input}
                  placeholder="What does this project do?"
                  placeholderTextColor={colors.mutedForeground}
                  value={description}
                  onChangeText={setDescription}
                />

                <View style={s.switchRow}>
                  <View>
                    <Text style={s.switchLabel}>Private repository</Text>
                    <Text style={s.switchSub}>Only you can see it</Text>
                  </View>
                  <Switch
                    value={isPrivate}
                    onValueChange={setIsPrivate}
                    trackColor={{ true: colors.primary }}
                    thumbColor="#fff"
                  />
                </View>

                {error ? <Text style={s.error}>{error}</Text> : null}

                <Pressable
                  style={[s.pushBtn, { opacity: loading ? 0.6 : 1 }]}
                  onPress={handlePush}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <MaterialCommunityIcons name="github" size={18} color="#fff" />
                      <Text style={s.pushBtnText}>Push to GitHub</Text>
                    </>
                  )}
                </Pressable>
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
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.6)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      maxHeight: "85%",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: {
      flex: 1,
      fontSize: 16,
      fontWeight: "600",
      color: colors.foreground,
    },
    body: { padding: 16 },
    label: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.mutedForeground,
      marginBottom: 6,
      marginTop: 12,
      textTransform: "uppercase",
      letterSpacing: 0.5,
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
    hint: {
      fontSize: 12,
      color: colors.mutedForeground,
      marginTop: 4,
      lineHeight: 18,
    },
    switchRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 16,
      paddingVertical: 4,
    },
    switchLabel: { fontSize: 14, color: colors.foreground, fontWeight: "500" },
    switchSub: { fontSize: 12, color: colors.mutedForeground, marginTop: 2 },
    error: {
      color: colors.destructive,
      fontSize: 13,
      marginTop: 12,
      textAlign: "center",
    },
    pushBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: "#24292e",
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 20,
      marginBottom: 8,
    },
    pushBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },

    // Success
    success: { alignItems: "center", paddingVertical: 24, gap: 12 },
    successEmoji: { fontSize: 48 },
    successTitle: { fontSize: 20, fontWeight: "700", color: colors.foreground },
    successUrl: { fontSize: 13, color: colors.mutedForeground },
    openBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 10,
    },
    openBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    deployHint: {
      fontSize: 13,
      color: colors.mutedForeground,
      textAlign: "center",
      lineHeight: 18,
      marginHorizontal: 8,
    },
  });
}
