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
  StyleSheet,
  Switch,
  Alert,
} from "react-native";
import { MaterialCommunityIcons, Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";
import { resolveApiBaseUrl } from "@/app/_layout";

// ── Storage keys ──────────────────────────────────────────────────────────────
const TOKEN_KEY = "clownin_gh_token";
const USERNAME_KEY = "clownin_gh_username";
function repoStorageKey(projectId: number) {
  return `clownin_gh_repo_${projectId}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

/** Verifies a GitHub PAT by calling the public /user endpoint. Returns the login or null. */
async function verifyGitHubToken(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as { login?: string };
    return data.login ?? null;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Step = "loading" | "connect" | "push" | "success";

interface LinkedRepo { owner: string; repoName: string; repoUrl: string; }
interface PushResult { repoUrl: string; owner: string; repoName: string; isContainerReady?: boolean; projectType?: string; isUpdate?: boolean; }

// ── Props ─────────────────────────────────────────────────────────────────────
interface GitHubExportModalProps {
  visible: boolean;
  onClose: () => void;
  projectId: number;
  projectName: string;
}

// ── Main component ────────────────────────────────────────────────────────────
export function GitHubExportModal({ visible, onClose, projectId, projectName }: GitHubExportModalProps) {
  const colors = useColors();
  const { token: authToken } = useAuth();

  const [step, setStep] = useState<Step>("loading");
  const [ghToken, setGhToken] = useState("");
  const [ghUsername, setGhUsername] = useState<string | null>(null);
  const [connectingToken, setConnectingToken] = useState("");
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectError, setConnectError] = useState("");

  const [repoName, setRepoName] = useState(slugify(projectName));
  const [isPrivate, setIsPrivate] = useState(false);
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [pushError, setPushError] = useState("");
  const [result, setResult] = useState<PushResult | null>(null);
  const [linkedRepo, setLinkedRepo] = useState<LinkedRepo | null>(null);

  // ── On open: verify saved token ─────────────────────────────────────────────
  useEffect(() => {
    if (!visible) {
      // Reset transient state on close, keep connection state
      setStep("loading");
      setPushError("");
      setResult(null);
      setConnectingToken("");
      setConnectError("");
      return;
    }

    setStep("loading");
    setRepoName(slugify(projectName));

    Promise.all([
      AsyncStorage.getItem(TOKEN_KEY).catch(() => null),
      AsyncStorage.getItem(USERNAME_KEY).catch(() => null),
      AsyncStorage.getItem(repoStorageKey(projectId)).catch(() => null),
    ]).then(async ([savedToken, savedUsername, rawRepo]) => {
      // Restore linked repo
      if (rawRepo) {
        try { setLinkedRepo(JSON.parse(rawRepo) as LinkedRepo); }
        catch { setLinkedRepo(null); }
      } else {
        setLinkedRepo(null);
      }

      if (!savedToken) {
        setStep("connect");
        return;
      }

      // Verify the saved token (use cached username as optimistic value, then confirm)
      if (savedUsername) setGhUsername(savedUsername);
      const login = await verifyGitHubToken(savedToken);
      if (login) {
        setGhToken(savedToken);
        setGhUsername(login);
        AsyncStorage.setItem(USERNAME_KEY, login).catch(() => {});
        setStep("push");
      } else {
        // Token is stale — clear it and prompt reconnect
        AsyncStorage.multiRemove([TOKEN_KEY, USERNAME_KEY]).catch(() => {});
        setGhToken("");
        setGhUsername(null);
        setStep("connect");
      }
    });
  }, [visible, projectId, projectName]);

  // ── Connect: validate and save a new token ──────────────────────────────────
  const handleConnect = useCallback(async () => {
    const tok = connectingToken.trim();
    if (!tok) { setConnectError("Paste your GitHub token above"); return; }
    setConnectLoading(true);
    setConnectError("");
    const login = await verifyGitHubToken(tok);
    if (!login) {
      setConnectError("Token is invalid or doesn't have the required permissions. Make sure it has repo scope.");
      setConnectLoading(false);
      return;
    }
    await Promise.all([
      AsyncStorage.setItem(TOKEN_KEY, tok).catch(() => {}),
      AsyncStorage.setItem(USERNAME_KEY, login).catch(() => {}),
    ]);
    setGhToken(tok);
    setGhUsername(login);
    setConnectingToken("");
    setConnectLoading(false);
    setStep("push");
  }, [connectingToken]);

  // ── Disconnect ──────────────────────────────────────────────────────────────
  const handleDisconnect = useCallback(() => {
    Alert.alert("Disconnect GitHub?", "You'll need to reconnect to push code again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await AsyncStorage.multiRemove([TOKEN_KEY, USERNAME_KEY]).catch(() => {});
          setGhToken("");
          setGhUsername(null);
          setStep("connect");
        },
      },
    ]);
  }, []);

  // ── Push to GitHub ──────────────────────────────────────────────────────────
  const handlePush = useCallback(async () => {
    if (!ghToken) { setStep("connect"); return; }
    const isUpdate = linkedRepo !== null;
    if (!isUpdate && !repoName.trim()) { setPushError("Enter a repository name"); return; }
    setLoading(true);
    setPushError("");

    try {
      const baseUrl = resolveApiBaseUrl();
      const body: Record<string, unknown> = {
        token: ghToken,
        repoName: isUpdate ? linkedRepo!.repoName : repoName.trim(),
        isPrivate,
        description: description.trim(),
      };
      if (isUpdate && linkedRepo) {
        body.existingRepo = { owner: linkedRepo.owner, repoName: linkedRepo.repoName };
      }

      const res = await fetch(`${baseUrl}/api/projects/${projectId}/github/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Push failed");

      const linked: LinkedRepo = { owner: data.owner, repoName: data.repoName, repoUrl: data.repoUrl };
      await AsyncStorage.setItem(repoStorageKey(projectId), JSON.stringify(linked)).catch(() => {});
      setLinkedRepo(linked);
      setResult({ ...data, isUpdate });
      setStep("success");
    } catch (err: unknown) {
      setPushError(err instanceof Error ? err.message : "Push failed");
    } finally {
      setLoading(false);
    }
  }, [ghToken, linkedRepo, repoName, isPrivate, description, projectId, authToken]);

  const s = makeStyles(colors);
  const isUpdate = linkedRepo !== null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={s.header}>
            <MaterialCommunityIcons name="github" size={22} color={colors.foreground} />
            <Text style={s.title}>
              {step === "connect" ? "Connect GitHub" : isUpdate ? "Update GitHub repo" : "Push to GitHub"}
            </Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView style={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {step === "loading" && (
              <View style={s.center}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[s.hintText, { marginTop: 12 }]}>Checking GitHub connection…</Text>
              </View>
            )}

            {step === "connect" && (
              <ConnectStep
                s={s}
                colors={colors}
                connectingToken={connectingToken}
                setConnectingToken={setConnectingToken}
                connectLoading={connectLoading}
                connectError={connectError}
                onConnect={handleConnect}
              />
            )}

            {step === "push" && (
              <PushStep
                s={s}
                colors={colors}
                ghUsername={ghUsername}
                onDisconnect={handleDisconnect}
                linkedRepo={linkedRepo}
                isUpdate={isUpdate}
                repoName={repoName}
                setRepoName={setRepoName}
                description={description}
                setDescription={setDescription}
                isPrivate={isPrivate}
                setIsPrivate={setIsPrivate}
                pushError={pushError}
                loading={loading}
                onPush={handlePush}
                onUnlinkRepo={async () => {
                  await AsyncStorage.removeItem(repoStorageKey(projectId)).catch(() => {});
                  setLinkedRepo(null);
                }}
                projectId={projectId}
              />
            )}

            {step === "success" && result && (
              <SuccessStep s={s} colors={colors} result={result} onClose={onClose} />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Connect step ──────────────────────────────────────────────────────────────
function ConnectStep({
  s, colors, connectingToken, setConnectingToken, connectLoading, connectError, onConnect,
}: {
  s: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
  connectingToken: string;
  setConnectingToken: (v: string) => void;
  connectLoading: boolean;
  connectError: string;
  onConnect: () => void;
}) {
  return (
    <View style={s.connectContainer}>
      <View style={[s.connectIconCircle, { backgroundColor: colors.card }]}>
        <MaterialCommunityIcons name="github" size={40} color={colors.foreground} />
      </View>

      <Text style={[s.connectTitle, { color: colors.foreground }]}>Connect your GitHub account</Text>
      <Text style={[s.connectSub, { color: colors.mutedForeground }]}>
        You only need to do this once. Your token is saved securely on this device.
      </Text>

      {/* Steps */}
      <View style={[s.stepsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Step1Row colors={colors} onOpenGitHub={() =>
          Linking.openURL("https://github.com/settings/tokens/new?scopes=repo,user&description=Clownin+App")
        } />
        <View style={[s.stepDivider, { backgroundColor: colors.border }]} />
        <View style={s.stepRow}>
          <View style={[s.stepBadge, { backgroundColor: colors.primary }]}>
            <Text style={s.stepBadgeText}>2</Text>
          </View>
          <Text style={[s.stepLabel, { color: colors.foreground }]}>Paste it below and tap Connect</Text>
        </View>
      </View>

      <TextInput
        style={[s.tokenInput, { backgroundColor: colors.input, borderColor: connectError ? colors.destructive : colors.border, color: colors.foreground }]}
        placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
        placeholderTextColor={colors.mutedForeground}
        value={connectingToken}
        onChangeText={setConnectingToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={false}
      />

      {connectError ? (
        <Text style={[s.errorText, { color: colors.destructive }]}>{connectError}</Text>
      ) : null}

      <Pressable
        style={[s.connectBtn, { backgroundColor: "#24292e", opacity: connectLoading ? 0.7 : 1 }]}
        onPress={onConnect}
        disabled={connectLoading}
      >
        {connectLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <MaterialCommunityIcons name="github" size={18} color="#fff" />
            <Text style={s.connectBtnText}>Connect GitHub</Text>
          </>
        )}
      </Pressable>

      <Text style={[s.footNote, { color: colors.mutedForeground }]}>
        Token requires <Text style={{ fontFamily: "Inter_600SemiBold" }}>repo</Text> scope to create and update repositories.
      </Text>
    </View>
  );
}

function Step1Row({ colors, onOpenGitHub }: { colors: ReturnType<typeof useColors>; onOpenGitHub: () => void }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={[{ width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" }, { backgroundColor: colors.primary }]}>
          <Text style={{ color: "#fff", fontSize: 12, fontFamily: "Inter_700Bold" }}>1</Text>
        </View>
        <Text style={[{ flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" }, { color: colors.foreground }]}>
          Create a GitHub Personal Access Token
        </Text>
      </View>
      <Pressable
        style={[{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 }, { borderColor: colors.border, backgroundColor: colors.background }]}
        onPress={onOpenGitHub}
      >
        <MaterialCommunityIcons name="open-in-new" size={14} color={colors.primary} />
        <Text style={[{ fontSize: 13, fontFamily: "Inter_500Medium" }, { color: colors.primary }]}>
          Open GitHub token settings →
        </Text>
      </Pressable>
    </View>
  );
}

// ── Push step ─────────────────────────────────────────────────────────────────
function PushStep({
  s, colors, ghUsername, onDisconnect, linkedRepo, isUpdate, repoName, setRepoName,
  description, setDescription, isPrivate, setIsPrivate, pushError, loading, onPush, onUnlinkRepo,
}: {
  s: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
  ghUsername: string | null;
  onDisconnect: () => void;
  linkedRepo: { owner: string; repoName: string; repoUrl: string } | null;
  isUpdate: boolean;
  repoName: string;
  setRepoName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  isPrivate: boolean;
  setIsPrivate: (v: boolean) => void;
  pushError: string;
  loading: boolean;
  onPush: () => void;
  onUnlinkRepo: () => void;
  projectId: number;
}) {
  return (
    <>
      {/* Connected badge */}
      <View style={[s.connectedBadge, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[s.connectedDot, { backgroundColor: "#3fb950" }]} />
        <View style={{ flex: 1 }}>
          <Text style={[s.connectedLabel, { color: colors.foreground }]}>
            Connected{ghUsername ? ` as @${ghUsername}` : " to GitHub"}
          </Text>
          <Text style={[s.connectedSub, { color: colors.mutedForeground }]}>Your token is saved on this device</Text>
        </View>
        <Pressable onPress={onDisconnect} hitSlop={8}>
          <Text style={[s.disconnectLink, { color: colors.mutedForeground }]}>Disconnect</Text>
        </Pressable>
      </View>

      {/* Linked repo or new repo form */}
      {isUpdate && linkedRepo ? (
        <View style={[s.linkedBanner, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <MaterialCommunityIcons name="source-branch-check" size={16} color="#3fb950" />
          <View style={{ flex: 1 }}>
            <Text style={[s.linkedBannerTitle, { color: colors.foreground }]}>
              {linkedRepo.owner}/{linkedRepo.repoName}
            </Text>
            <Text style={[s.linkedBannerSub, { color: colors.mutedForeground }]}>
              A new commit will be pushed to this repo
            </Text>
          </View>
          <Pressable onPress={onUnlinkRepo} hitSlop={8}>
            <MaterialCommunityIcons name="link-off" size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={s.label}>Repository Name</Text>
          <TextInput
            style={[s.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground }]}
            placeholder="my-project"
            placeholderTextColor={colors.mutedForeground}
            value={repoName}
            onChangeText={(t) => setRepoName(slugify(t))}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={s.label}>Description (optional)</Text>
          <TextInput
            style={[s.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground }]}
            placeholder="What does this project do?"
            placeholderTextColor={colors.mutedForeground}
            value={description}
            onChangeText={setDescription}
          />

          <View style={s.switchRow}>
            <View>
              <Text style={[s.switchLabel, { color: colors.foreground }]}>Private repository</Text>
              <Text style={[s.switchSub, { color: colors.mutedForeground }]}>Only you can see it</Text>
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

      {pushError ? <Text style={[s.errorText, { color: colors.destructive }]}>{pushError}</Text> : null}

      <Pressable
        style={[s.pushBtn, { opacity: loading ? 0.6 : 1 }]}
        onPress={onPush}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <MaterialCommunityIcons name="source-branch" size={18} color="#fff" />
            <Text style={s.pushBtnText}>{isUpdate ? "Push update" : "Create & push"}</Text>
          </>
        )}
      </Pressable>
    </>
  );
}

// ── Success step ──────────────────────────────────────────────────────────────
function SuccessStep({ s, colors, result, onClose }: {
  s: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
  result: PushResult;
  onClose: () => void;
}) {
  const deployPlatforms = result.isContainerReady
    ? [
        { name: "Railway", icon: "train-variant" as const, desc: "Connect GitHub → auto-deploys on every push", color: "#7B3FE4", url: `https://railway.app/new/github?repo=${encodeURIComponent(result.repoUrl)}` },
        { name: "Render",  icon: "cloud-upload-outline" as const, desc: "Free tier · connect GitHub repo · done", color: "#46E3B7", url: `https://dashboard.render.com/web/new?url=${encodeURIComponent(result.repoUrl)}` },
        { name: "Fly.io",  icon: "rocket-launch-outline" as const, desc: "Add one GitHub secret → auto-deploys on push", color: "#8B5CF6", url: "https://fly.io/docs/getting-started/" },
      ]
    : [
        { name: "Vercel",  icon: "triangle-outline" as const, desc: "Best for JS/TS, Next.js, static sites", color: "#000", url: `https://vercel.com/new/clone?repository-url=${encodeURIComponent(result.repoUrl)}` },
        { name: "Railway", icon: "train-variant" as const, desc: "Any language, batteries included", color: "#7B3FE4", url: `https://railway.app/new/github?repo=${encodeURIComponent(result.repoUrl)}` },
        { name: "Render",  icon: "cloud-upload-outline" as const, desc: "Free tier, easy setup, all runtimes", color: "#46E3B7", url: `https://dashboard.render.com/web/new?url=${encodeURIComponent(result.repoUrl)}` },
      ];

  return (
    <View style={s.success}>
      <Text style={s.successEmoji}>{result.isUpdate ? "✅" : "🚀"}</Text>
      <Text style={[s.successTitle, { color: colors.foreground }]}>
        {result.isUpdate ? "GitHub repo updated" : "Live on GitHub"}
      </Text>
      <Pressable onPress={() => Linking.openURL(result.repoUrl)}>
        <Text style={[s.successUrl, { color: "#58a6ff" }]}>{result.repoUrl}</Text>
      </Pressable>

      {result.isContainerReady && (
        <View style={[s.containerBadge, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={s.containerBadgeIcon}>🐳</Text>
          <View style={{ flex: 1 }}>
            <Text style={[s.containerBadgeTitle, { color: colors.foreground }]}>Container deploy ready</Text>
            <Text style={[s.containerBadgeSub, { color: colors.mutedForeground }]}>Dockerfile &amp; docker-compose.yml included</Text>
          </View>
        </View>
      )}

      {result.isUpdate ? (
        <>
          <Text style={[s.deployHeading, { color: colors.mutedForeground }]}>Connected deploys will auto-trigger</Text>
          <Pressable style={[s.repoBtn, { borderColor: colors.border }]} onPress={() => Linking.openURL(result.repoUrl)}>
            <MaterialCommunityIcons name="github" size={16} color={colors.foreground} />
            <Text style={[s.repoBtnText, { color: colors.foreground }]}>View on GitHub</Text>
          </Pressable>
          <Pressable style={[s.repoBtn, { borderColor: colors.border }]} onPress={onClose}>
            <Text style={[s.repoBtnText, { color: colors.mutedForeground }]}>Done</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[s.deployHeading, { color: colors.mutedForeground }]}>Deploy it live — pick a platform</Text>
          {deployPlatforms.map((p) => (
            <Pressable key={p.name} style={[s.deployCard, { borderColor: colors.border, backgroundColor: colors.card }]} onPress={() => Linking.openURL(p.url)}>
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
          <Pressable style={[s.repoBtn, { borderColor: colors.border }]} onPress={() => Linking.openURL(result.repoUrl)}>
            <MaterialCommunityIcons name="github" size={16} color={colors.foreground} />
            <Text style={[s.repoBtnText, { color: colors.foreground }]}>View on GitHub</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
    sheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: colors.border, maxHeight: "88%" },
    header: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { flex: 1, fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.foreground },
    body: { padding: 16 },

    center: { alignItems: "center", paddingVertical: 40 },
    hintText: { fontSize: 13, fontFamily: "Inter_400Regular", color: colors.mutedForeground, textAlign: "center" },

    // Connect step
    connectContainer: { alignItems: "center", gap: 12, paddingBottom: 8 },
    connectIconCircle: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", marginBottom: 4 },
    connectTitle: { fontSize: 18, fontFamily: "Inter_700Bold", textAlign: "center" },
    connectSub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19 },
    stepsCard: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 12, alignSelf: "stretch" },
    stepRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    stepBadge: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
    stepBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_700Bold" },
    stepLabel: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" },
    stepDivider: { height: 1 },
    tokenInput: { alignSelf: "stretch", borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, fontFamily: "Inter_400Regular" },
    errorText: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
    connectBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 12, paddingVertical: 14, alignSelf: "stretch" },
    connectBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_700Bold" },
    footNote: { fontSize: 11, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 16, paddingHorizontal: 8 },

    // Push step
    connectedBadge: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 16 },
    connectedDot: { width: 8, height: 8, borderRadius: 4 },
    connectedLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
    connectedSub: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
    disconnectLink: { fontSize: 12, fontFamily: "Inter_500Medium" },
    linkedBanner: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 16 },
    linkedBannerTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
    linkedBannerSub: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
    label: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: colors.mutedForeground, marginBottom: 6, marginTop: 14, textTransform: "uppercase", letterSpacing: 0.5 },
    input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_400Regular" },
    switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingVertical: 4 },
    switchLabel: { fontSize: 14, fontFamily: "Inter_500Medium" },
    switchSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
    pushBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#24292e", borderRadius: 10, paddingVertical: 14, marginTop: 20, marginBottom: 8 },
    pushBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },

    // Success
    success: { alignItems: "stretch", paddingVertical: 8, gap: 10 },
    successEmoji: { fontSize: 40, textAlign: "center" },
    successTitle: { fontSize: 20, fontFamily: "Inter_700Bold", textAlign: "center" },
    successUrl: { fontSize: 12, textAlign: "center", textDecorationLine: "underline", fontFamily: "Inter_400Regular" },
    deployHeading: { fontSize: 11, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 8 },
    deployCard: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 12, padding: 12 },
    deployIconBox: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    deployCardText: { flex: 1 },
    deployCardName: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
    deployCardDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
    repoBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderRadius: 10, paddingVertical: 11, marginTop: 4 },
    repoBtnText: { fontSize: 14, fontFamily: "Inter_500Medium" },
    containerBadge: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 4 },
    containerBadgeIcon: { fontSize: 22 },
    containerBadgeTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
    containerBadgeSub: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 1, lineHeight: 15 },
  });
}
