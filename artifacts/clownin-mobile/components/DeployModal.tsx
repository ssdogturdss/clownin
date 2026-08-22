import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ActivityIndicator,
  ScrollView,
  Linking,
  Share,
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
  /** Whether this project is attached to a configured Ubuntu/SSH server. */
  hasUbuntuServer?: boolean;
  /** Whether the current project file can be started as a remote web server. */
  canDeployToUbuntu?: boolean;
  /** Starts the existing authenticated remote preview/server flow. */
  onDeployToUbuntu?: () => void;
  /** Opens the server setup screen when no Ubuntu target is configured. */
  onOpenUbuntuSetup?: () => void;
  /** Called when a deploy succeeds so the caller can persist and show the URL. */
  onDeploySuccess?: (url: string, platform: string) => void;
  /** Opens the in-app EAS Build status screen. */
  onOpenEasBuilds?: () => void;
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

function tokenKey(p: Platform) { return `clownin_${p}_token`; }
function deployedUrlKey(id: number) { return `clownin_deployed_url_${id}`; }
/** Netlify siteId or Vercel deploymentId — lets us re-deploy to the same URL. */
function siteIdKey(p: Platform, id: number) { return `clownin_${p}_site_${id}`; }

export { deployedUrlKey };

export function DeployModal({
  visible, onClose, projectId, projectName, hasUbuntuServer = false,
  canDeployToUbuntu = false, onDeployToUbuntu, onOpenUbuntuSetup, onDeploySuccess,
  onOpenEasBuilds,
}: DeployModalProps) {
  const colors = useColors();
  const { token } = useAuth();
  const s = makeStyles(colors);

  const [platform, setPlatform] = useState<Platform>("netlify");
  const [tokens, setTokens] = useState<Record<Platform, string>>({ netlify: "", vercel: "" });
  /** Saved site/project IDs — lets re-deploys hit the same URL instead of creating a new site. */
  const [siteIds, setSiteIds] = useState<Record<Platform, string>>({ netlify: "", vercel: "" });
  const [name, setName] = useState(slugify(projectName));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ url: string; platform: Platform; warning?: string } | null>(null);
  const [error, setError] = useState("");
  // "quick" = token already saved, skip the form and deploy on one tap
  const [quickMode, setQuickMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBuildTargets, setShowBuildTargets] = useState(true);
  /** Whether the server-side EAS key is configured and reachable. */
  const [hasExpoToken, setHasExpoToken] = useState(false);
  /** Expo username returned by /api/eas/viewer, shown in the Connected badge. */
  const [easUsername, setEasUsername] = useState<string>("");

  // Reset and load saved tokens + site IDs whenever the modal opens
  useEffect(() => {
    if (!visible) return;
    setName(slugify(projectName));
    setResult(null);
    setError("");
    setShowSettings(false);
    setShowBuildTargets(true);

    // Load deploy tokens/platform from storage
    Promise.all([
      AsyncStorage.getItem(tokenKey("netlify")),
      AsyncStorage.getItem(tokenKey("vercel")),
      AsyncStorage.getItem(`clownin_deploy_platform`),
      AsyncStorage.getItem(siteIdKey("netlify", projectId)),
      AsyncStorage.getItem(siteIdKey("vercel", projectId)),
    ]).then(([nt, vt, savedPlatform, nSiteId, vSiteId]) => {
      const savedTokens = { netlify: nt ?? "", vercel: vt ?? "" };
      setTokens(savedTokens);
      setSiteIds({ netlify: nSiteId ?? "", vercel: vSiteId ?? "" });
      const activePlatform: Platform = savedPlatform === "vercel" ? "vercel" : "netlify";
      setPlatform(activePlatform);
      setQuickMode(!!savedTokens[activePlatform]);
    });

    // Check EAS connectivity via the server — the token lives server-side
    setHasExpoToken(false);
    setEasUsername("");
    if (token) {
      const base = resolveApiBaseUrl();
      fetch(`${base}/api/eas/viewer`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(async (r) => {
          if (r.ok) {
            const data = await r.json().catch(() => ({}));
            setHasExpoToken(true);
            setEasUsername((data as { username?: string }).username ?? "");
          } else {
            setHasExpoToken(false);
          }
        })
        .catch(() => setHasExpoToken(false));
    }
  }, [visible, projectName, projectId, token]);

  // When platform changes in settings, check if quick mode applies
  useEffect(() => {
    if (!visible) return;
    setQuickMode(!!tokens[platform] && !showSettings);
  }, [platform, tokens, showSettings, visible]);

  const currentPlatform = PLATFORMS.find((p) => p.id === platform)!;
  const currentToken = tokens[platform];

  const handleDeploy = useCallback(async () => {
    const deployToken = currentToken.trim();
    if (!deployToken) { setError(`Enter your ${currentPlatform.label} token`); return; }
    setLoading(true);
    setError("");

    // Persist token + platform preference
    await AsyncStorage.setItem(tokenKey(platform), deployToken);
    await AsyncStorage.setItem("clownin_deploy_platform", platform);

    try {
      const baseUrl = resolveApiBaseUrl();
      const existingSiteId = siteIds[platform]?.trim() || undefined;
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/deploy/${platform}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          token: deployToken,
          siteName: name.trim(),
          projectName: name.trim(),
          // Pass the saved siteId so the server reuses the same site instead of creating a new one
          ...(existingSiteId ? { siteId: existingSiteId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deploy failed");
      const deployResult = { url: data.url, platform, warning: data.warning };
      setResult(deployResult);
      // Persist deployed URL so the project list can show the Live badge
      await AsyncStorage.setItem(deployedUrlKey(projectId), data.url);
      // Persist siteId so future deploys hit the same site (same URL for users)
      const returnedSiteId = data.siteId || data.deploymentId;
      if (returnedSiteId) {
        setSiteIds((prev) => ({ ...prev, [platform]: returnedSiteId }));
        await AsyncStorage.setItem(siteIdKey(platform, projectId), returnedSiteId);
      }
      onDeploySuccess?.(data.url, platform);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setLoading(false);
    }
  }, [currentToken, currentPlatform, platform, name, projectId, token, siteIds, onDeploySuccess]);

  const handleShare = useCallback(async () => {
    if (!result) return;
    try {
      await Share.share({ message: result.url, url: result.url });
    } catch { /* user dismissed */ }
  }, [result]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={s.header}>
            <MaterialCommunityIcons name="rocket-launch-outline" size={22} color={colors.primary} />
            <Text style={s.title}>Build & Deploy</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <MaterialCommunityIcons name="close" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView style={s.body} keyboardShouldPersistTaps="handled">
            {result ? (
              /* ── Success screen ── */
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
                <View style={s.successActions}>
                  <Pressable
                    style={[s.openBtn, { backgroundColor: colors.primary }]}
                    onPress={() => Linking.openURL(result.url)}
                  >
                    <MaterialCommunityIcons name="open-in-new" size={16} color="#fff" />
                    <Text style={s.openBtnText}>Open App</Text>
                  </Pressable>
                  <Pressable
                    style={[s.shareBtn, { borderColor: colors.border }]}
                    onPress={handleShare}
                  >
                    <MaterialCommunityIcons name="share-variant-outline" size={16} color={colors.foreground} />
                    <Text style={[s.shareBtnText, { color: colors.foreground }]}>Share</Text>
                  </Pressable>
                </View>
                <Pressable onPress={() => setResult(null)} style={s.deployAgainRow}>
                  <Text style={[s.deployAgainText, { color: colors.mutedForeground }]}>Deploy again</Text>
                </Pressable>
              </View>
            ) : showBuildTargets ? (
              <View style={s.targetList}>
                <Text style={[s.targetIntro, { color: colors.mutedForeground }]}>
                  Where should this project go?
                </Text>

                {/* ── EAS Builds ── */}
                <Pressable
                  testID="expo-launch-button"
                  style={[s.targetCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => { onClose(); onOpenEasBuilds?.(); }}
                >
                  <View style={[s.targetIcon, { backgroundColor: "#58a6ff22" }]}>
                    <MaterialCommunityIcons name="cellphone-arrow-down" size={21} color="#58a6ff" />
                  </View>
                  <View style={s.targetCopy}>
                    <View style={s.targetTitleRow}>
                      <Text style={[s.targetTitle, { color: colors.foreground }]}>EAS Builds</Text>
                      {hasExpoToken && (
                        <View style={[s.connectedBadge, { backgroundColor: "#3fb95022", borderColor: "#3fb95055" }]}>
                          <View style={[s.connectedDot, { backgroundColor: "#3fb950" }]} />
                          <Text style={[s.connectedText, { color: "#3fb950" }]}>
                            {easUsername ? `@${easUsername}` : "Connected"}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={[s.targetDescription, { color: colors.mutedForeground }]}>
                      Build queue, artifacts, and App Store submissions.
                    </Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" size={19} color={colors.mutedForeground} />
                </Pressable>

                {/* ── Ubuntu ── */}
                <Pressable
                  testID="ubuntu-deploy-button"
                  style={[s.targetCard, {
                    backgroundColor: colors.card,
                    borderColor: hasUbuntuServer && canDeployToUbuntu ? colors.primary + "88" : colors.border,
                  }]}
                  onPress={() => {
                    if (hasUbuntuServer && canDeployToUbuntu) { onClose(); onDeployToUbuntu?.(); }
                    else { onClose(); onOpenUbuntuSetup?.(); }
                  }}
                >
                  <View style={[s.targetIcon, { backgroundColor: colors.primary + "22" }]}>
                    <MaterialCommunityIcons name="server-network" size={21} color={colors.primary} />
                  </View>
                  <View style={s.targetCopy}>
                    <View style={s.targetTitleRow}>
                      <Text style={[s.targetTitle, { color: colors.foreground }]}>
                        {hasUbuntuServer ? "Ubuntu Server" : "Connect Ubuntu"}
                      </Text>
                      {hasUbuntuServer && (
                        <View style={[s.connectedBadge, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" }]}>
                          <View style={[s.connectedDot, { backgroundColor: colors.primary }]} />
                          <Text style={[s.connectedText, { color: colors.primary }]}>Ready</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[s.targetDescription, { color: colors.mutedForeground }]}>
                      {hasUbuntuServer
                        ? canDeployToUbuntu
                          ? "Run this project on your SSH server."
                          : "Select a server file first, then deploy."
                        : "Add an Ubuntu 20.04+ host via SSH."}
                    </Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" size={19} color={colors.mutedForeground} />
                </Pressable>

                {/* ── Web hosting (secondary) ── */}
                <Pressable
                  testID="web-hosting-button"
                  style={[s.webTargetButton, { borderColor: colors.border }]}
                  onPress={() => setShowBuildTargets(false)}
                >
                  <MaterialCommunityIcons name="web" size={16} color={colors.mutedForeground} />
                  <Text style={[s.webTargetText, { color: colors.mutedForeground }]}>
                    Netlify or Vercel
                  </Text>
                  <MaterialCommunityIcons name="chevron-right" size={15} color={colors.mutedForeground} style={{ marginLeft: "auto" }} />
                </Pressable>
              </View>
            ) : quickMode && !showSettings ? (
              /* ── One-tap mode: token already saved ── */
              <View style={s.quickMode}>
                {/* Platform pill */}
                <View style={[s.platformPill, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <MaterialCommunityIcons
                    name={currentPlatform.icon as never}
                    size={20}
                    color={currentPlatform.color}
                  />
                  <Text style={[s.platformPillText, { color: colors.foreground }]}>{currentPlatform.label}</Text>
                  <View style={[s.tokenDot, { backgroundColor: "#3fb950" }]} />
                  <Text style={[s.tokenSavedText, { color: "#3fb950" }]}>Token saved</Text>
                </View>

                <Text style={[s.siteName, { color: colors.mutedForeground }]}>
                  Site: <Text style={{ color: colors.foreground }}>{name}</Text>
                </Text>

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

                <Pressable onPress={() => setShowBuildTargets(true)} style={s.backRow}>
                  <MaterialCommunityIcons name="arrow-left" size={16} color={colors.primary} />
                  <Text style={[s.backText, { color: colors.primary }]}>Back to deployment targets</Text>
                </Pressable>
                <Pressable onPress={() => setShowSettings(true)} style={s.changeSettings}>
                  <Text style={[s.changeSettingsText, { color: colors.mutedForeground }]}>
                    Change platform or token
                  </Text>
                </Pressable>
              </View>
            ) : (
              /* ── First-time or settings mode: full form ── */
              <>
                {showSettings && (
                  <Pressable onPress={() => setShowSettings(false)} style={s.backRow}>
                    <MaterialCommunityIcons name="arrow-left" size={16} color={colors.primary} />
                    <Text style={[s.backText, { color: colors.primary }]}>Back</Text>
                  </Pressable>
                )}

                {!showSettings && (
                  <Pressable onPress={() => setShowBuildTargets(true)} style={s.backRow}>
                    <MaterialCommunityIcons name="arrow-left" size={16} color={colors.primary} />
                    <Text style={[s.backText, { color: colors.primary }]}>Back to deployment targets</Text>
                  </Pressable>
                )}

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

    // One-tap / quick mode
    quickMode: { paddingVertical: 8, gap: 16 },
    platformPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      alignSelf: "flex-start",
    },
    platformPillText: { fontSize: 15, fontWeight: "600" },
    tokenDot: { width: 7, height: 7, borderRadius: 4, marginLeft: 4 },
    tokenSavedText: { fontSize: 12, fontWeight: "500" },
    siteName: { fontSize: 13 },
    changeSettings: { alignItems: "center", paddingVertical: 4 },
    changeSettingsText: { fontSize: 12, textDecorationLine: "underline" },
    backRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 },
    backText: { fontSize: 14, fontWeight: "500" },
    targetList: { gap: 10, paddingVertical: 8 },
    targetIntro: { fontSize: 12, lineHeight: 18, marginBottom: 4 },
    targetCard: {
      flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1,
      borderRadius: 14, padding: 14,
    },
    targetIcon: {
      width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", flexShrink: 0,
    },
    targetCopy: { flex: 1, gap: 4 },
    targetTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    targetTitle: { fontSize: 15, fontWeight: "700" },
    targetDescription: { fontSize: 12, lineHeight: 17, color: colors.mutedForeground },
    connectedBadge: {
      flexDirection: "row", alignItems: "center", gap: 4,
      borderWidth: 1, borderRadius: 20, paddingHorizontal: 7, paddingVertical: 2,
    },
    connectedDot: { width: 5, height: 5, borderRadius: 3 },
    connectedText: { fontSize: 10, fontWeight: "700" },
    webTargetButton: {
      flexDirection: "row", alignItems: "center",
      gap: 7, borderWidth: 1, borderRadius: 10,
      paddingVertical: 10, paddingHorizontal: 14, marginTop: 2,
    },
    webTargetText: { fontSize: 13, fontWeight: "500" },

    // Full form
    platformRow: { flexDirection: "row", gap: 10, marginBottom: 8 },
    platformBtn: {
      flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
      gap: 7, borderWidth: 1, borderRadius: 10, paddingVertical: 10,
    },
    platformLabel: { fontSize: 14, fontWeight: "600" },
    platformDesc: { fontSize: 12, marginBottom: 4 },
    label: {
      fontSize: 11, fontWeight: "600", color: colors.mutedForeground,
      textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 6,
    },
    input: {
      backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border,
      borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
      color: colors.foreground, fontSize: 14,
    },
    hint: { fontSize: 12, marginTop: 4 },
    error: { color: colors.destructive, fontSize: 13, marginTop: 10, textAlign: "center" },
    deployBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center",
      gap: 8, borderRadius: 10, paddingVertical: 14, marginTop: 18,
    },
    deployBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    fineprint: { fontSize: 11, textAlign: "center", marginTop: 10, marginBottom: 4, lineHeight: 16 },

    // Success
    success: { alignItems: "center", paddingVertical: 32, gap: 14 },
    successEmoji: { fontSize: 52 },
    successTitle: { fontSize: 24, fontWeight: "800", color: colors.foreground },
    successUrl: { fontSize: 13, textDecorationLine: "underline", textAlign: "center" },
    successActions: { flexDirection: "row", gap: 10, flexWrap: "wrap", justifyContent: "center" },
    openBtn: {
      flexDirection: "row", alignItems: "center", gap: 8,
      paddingHorizontal: 20, paddingVertical: 13, borderRadius: 12,
    },
    openBtnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
    shareBtn: {
      flexDirection: "row", alignItems: "center", gap: 8,
      paddingHorizontal: 20, paddingVertical: 13, borderRadius: 12,
      borderWidth: 1,
    },
    shareBtnText: { fontWeight: "600", fontSize: 16 },
    deployAgainRow: { paddingVertical: 4 },
    deployAgainText: { fontSize: 13 },
    deployWarning: {
      fontSize: 12, lineHeight: 18, textAlign: "center",
      borderWidth: 1, borderRadius: 8, padding: 10, marginHorizontal: 4,
    },
  });
}
