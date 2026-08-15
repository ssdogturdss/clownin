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
function repoStorageKey(projectId: number) {
  return `clownin_gh_repo_${projectId}`;
}

interface LinkedRepo {
  owner: string;
  repoName: string;
  repoUrl: string;
}

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
  const [result, setResult] = useState<{
    repoUrl: string;
    owner: string;
    isContainerReady?: boolean;
    projectType?: string;
    isUpdate?: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [linkedRepo, setLinkedRepo] = useState<LinkedRepo | null>(null);

  // Load saved token and linked repo
  useEffect(() => {
    if (visible) {
      AsyncStorage.getItem(TOKEN_KEY).then((t) => { if (t) setGhToken(t); }).catch(() => {});
      AsyncStorage.getItem(repoStorageKey(projectId)).then((raw) => {
        if (raw) {
          try {
            setLinkedRepo(JSON.parse(raw) as LinkedRepo);
          } catch {
            setLinkedRepo(null);
          }
        } else {
          setLinkedRepo(null);
        }
      }).catch(() => {});
      setRepoName(slugify(projectName));
      setResult(null);
      setError("");
    }
  }, [visible, projectName, projectId]);

  const isUpdate = linkedRepo !== null;

  const handlePush = async () => {
    if (!ghToken.trim()) { setError("Enter your GitHub token"); return; }
    if (!isUpdate && !repoName.trim()) { setError("Enter a repo name"); return; }
    setLoading(true);
    setError("");

    try {
      // Save token for next time
      await AsyncStorage.setItem(TOKEN_KEY, ghToken.trim());

      const baseUrl = resolveApiBaseUrl();

      const bodyPayload: Record<string, unknown> = {
        token: ghToken.trim(),
        repoName: isUpdate ? linkedRepo!.repoName : repoName.trim(),
        isPrivate,
        description: description.trim(),
      };

      if (isUpdate && linkedRepo) {
        bodyPayload.existingRepo = {
          owner: linkedRepo.owner,
          repoName: linkedRepo.repoName,
        };
      }

      const res = await fetch(`${baseUrl}/api/projects/${projectId}/github/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Push failed");

      // Persist linked repo info
      const linked: LinkedRepo = {
        owner: data.owner,
        repoName: data.repoName,
        repoUrl: data.repoUrl,
      };
      await AsyncStorage.setItem(repoStorageKey(projectId), JSON.stringify(linked));
      setLinkedRepo(linked);

      setResult({ ...data, isUpdate });
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
            <Text style={s.title}>{isUpdate ? "Update GitHub repo" : "Push to GitHub"}</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <MaterialCommunityIcons name="close" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView style={s.body} keyboardShouldPersistTaps="handled">
            {result ? (
              /* ── Success + Deploy state ── */
              <View style={s.success}>
                <Text style={s.successEmoji}>{result.isUpdate ? "✅" : "🚀"}</Text>
                <Text style={s.successTitle}>
                  {result.isUpdate ? "GitHub repo updated" : "Live on GitHub"}
                </Text>
                <Pressable onPress={() => Linking.openURL(result.repoUrl)}>
                  <Text style={[s.successUrl, { color: colors.info }]}>{result.repoUrl}</Text>
                </Pressable>

                {/* Container-ready badge */}
                {result.isContainerReady && (
                  <View style={[s.containerBadge, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={s.containerBadgeIcon}>🐳</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.containerBadgeTitle, { color: colors.foreground }]}>
                        Container deploy ready
                      </Text>
                      <Text style={[s.containerBadgeSub, { color: colors.mutedForeground }]}>
                        Dockerfile &amp; docker-compose.yml included in the commit
                      </Text>
                    </View>
                  </View>
                )}

                {result.isUpdate ? (
                  /* Update success — just show repo link */
                  <>
                    <Text style={[s.deployHeading, { marginTop: 8 }]}>
                      Any connected deploys will auto-trigger
                    </Text>
                    <Pressable
                      style={[s.repoBtn, { borderColor: colors.border }]}
                      onPress={() => Linking.openURL(result.repoUrl)}
                    >
                      <MaterialCommunityIcons name="github" size={16} color={colors.foreground} />
                      <Text style={[s.repoBtnText, { color: colors.foreground }]}>View on GitHub</Text>
                    </Pressable>
                  </>
                ) : (
                  /* First push — show deploy platforms */
                  <>
                    <Text style={s.deployHeading}>Deploy it live — pick a platform</Text>

                    {(result.isContainerReady
                      ? [
                          {
                            name: "Railway",
                            icon: "train-variant" as const,
                            desc: "Connect GitHub → auto-deploys on every push",
                            color: "#7B3FE4",
                            url: `https://railway.app/new/github?repo=${encodeURIComponent(result.repoUrl)}`,
                          },
                          {
                            name: "Render",
                            icon: "cloud-upload-outline" as const,
                            desc: "Free tier · connect GitHub repo · done",
                            color: "#46E3B7",
                            url: `https://dashboard.render.com/web/new?url=${encodeURIComponent(result.repoUrl)}`,
                          },
                          {
                            name: "Fly.io",
                            icon: "rocket-launch-outline" as const,
                            desc: "Add one GitHub secret → auto-deploys on every push",
                            color: "#8B5CF6",
                            url: "https://fly.io/docs/getting-started/",
                          },
                        ]
                      : [
                          {
                            name: "Vercel",
                            icon: "triangle-outline" as const,
                            desc: "Best for JS/TS, Next.js, static sites",
                            color: "#000",
                            url: `https://vercel.com/new/clone?repository-url=${encodeURIComponent(result.repoUrl)}`,
                          },
                          {
                            name: "Railway",
                            icon: "train-variant" as const,
                            desc: "Any language, batteries included",
                            color: "#7B3FE4",
                            url: `https://railway.app/new/github?repo=${encodeURIComponent(result.repoUrl)}`,
                          },
                          {
                            name: "Render",
                            icon: "cloud-upload-outline" as const,
                            desc: "Free tier, easy setup, all runtimes",
                            color: "#46E3B7",
                            url: `https://dashboard.render.com/web/new?url=${encodeURIComponent(result.repoUrl)}`,
                          },
                        ]
                    ).map((p) => (
                      <Pressable
                        key={p.name}
                        style={[s.deployCard, { borderColor: colors.border, backgroundColor: colors.card }]}
                        onPress={() => Linking.openURL(p.url)}
                      >
                        <View style={[s.deployIconBox, { backgroundColor: p.color + "22" }]}>
                          <MaterialCommunityIcons name={p.icon} size={20} color={p.color === "#000" ? colors.foreground : p.color} />
                        </View>
                        <View style={s.deployCardText}>
                          <Text style={[s.deployCardName, { color: colors.foreground }]}>{p.name}</Text>
                          <Text style={[s.deployCardDesc, { color: colors.mutedForeground }]}>{p.desc}</Text>
                        </View>
                        <MaterialCommunityIcons name="arrow-right" size={16} color={colors.mutedForeground} />
                      </Pressable>
                    ))}

                    <Pressable
                      style={[s.repoBtn, { borderColor: colors.border }]}
                      onPress={() => Linking.openURL(result.repoUrl)}
                    >
                      <MaterialCommunityIcons name="github" size={16} color={colors.foreground} />
                      <Text style={[s.repoBtnText, { color: colors.foreground }]}>View on GitHub</Text>
                    </Pressable>
                  </>
                )}
              </View>
            ) : (
              /* ── Form ── */
              <>
                {/* Linked repo banner */}
                {linkedRepo && (
                  <View style={[s.linkedBanner, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <MaterialCommunityIcons name="source-branch-check" size={16} color={colors.info} />
                    <View style={{ flex: 1 }}>
                      <Text style={[s.linkedBannerTitle, { color: colors.foreground }]}>
                        Linked to {linkedRepo.owner}/{linkedRepo.repoName}
                      </Text>
                      <Text style={[s.linkedBannerSub, { color: colors.mutedForeground }]}>
                        This will push a new commit to that repo
                      </Text>
                    </View>
                    <Pressable
                      hitSlop={8}
                      onPress={async () => {
                        await AsyncStorage.removeItem(repoStorageKey(projectId));
                        setLinkedRepo(null);
                      }}
                    >
                      <MaterialCommunityIcons name="link-off" size={16} color={colors.mutedForeground} />
                    </Pressable>
                  </View>
                )}

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

                {!isUpdate && (
                  <>
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
                  </>
                )}

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
                      <Text style={s.pushBtnText}>
                        {isUpdate ? "Update GitHub repo" : "Push to GitHub"}
                      </Text>
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

    // Linked repo banner
    linkedBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      marginBottom: 4,
    },
    linkedBannerTitle: { fontSize: 13, fontWeight: "600" },
    linkedBannerSub: { fontSize: 11, marginTop: 2 },

    // Success + deploy
    success: { alignItems: "stretch", paddingVertical: 16, gap: 10 },
    successEmoji: { fontSize: 40, textAlign: "center" },
    successTitle: { fontSize: 20, fontWeight: "700", color: colors.foreground, textAlign: "center" },
    successUrl: { fontSize: 12, textAlign: "center", textDecorationLine: "underline" },
    deployHeading: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginTop: 8,
    },
    deployCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
    },
    deployIconBox: {
      width: 36,
      height: 36,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    deployCardText: { flex: 1 },
    deployCardName: { fontSize: 14, fontWeight: "600" },
    deployCardDesc: { fontSize: 12, marginTop: 1 },
    repoBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: 11,
      marginTop: 4,
    },
    repoBtnText: { fontSize: 14, fontWeight: "500" },

    // Container-ready badge
    containerBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      marginTop: 4,
    },
    containerBadgeIcon: { fontSize: 22 },
    containerBadgeTitle: { fontSize: 13, fontWeight: "600" },
    containerBadgeSub: { fontSize: 11, marginTop: 1, lineHeight: 15 },
  });
}
