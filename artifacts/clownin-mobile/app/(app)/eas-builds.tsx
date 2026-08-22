import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Linking,
  ScrollView,
  Modal,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { resolveApiBaseUrl } from '@/app/_layout';

// ─── Status / platform maps ───────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  FINISHED:    '#3fb950',
  IN_PROGRESS: '#58a6ff',
  ERRORED:     '#f85149',
  CANCELED:    '#6e7681',
  IN_QUEUE:    '#d29922',
  NEW:         '#d29922',
};

const STATUS_LABEL: Record<string, string> = {
  FINISHED:    'Done',
  IN_PROGRESS: 'Building',
  ERRORED:     'Failed',
  CANCELED:    'Canceled',
  IN_QUEUE:    'Queued',
  NEW:         'Queued',
};

const PLATFORM_COLOR: Record<string, string> = {
  IOS:     '#a8b2bf',
  ANDROID: '#3ddc84',
};

const PLATFORM_ICON: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  IOS:     'apple',
  ANDROID: 'android',
};

const PLATFORM_LABEL: Record<string, string> = {
  IOS:     'iOS',
  ANDROID: 'Android',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function initials(name: string): string {
  return name
    .split(/[\s_-]/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface EASBuild {
  id: string;
  status: string;
  platform: string;
  createdAt: string;
  expirationDate?: string;
  app: { name: string; slug: string };
  artifacts?: { buildUrl?: string };
}

interface GitHubRepository {
  githubRepositoryUrl: string;
  metadata: {
    githubRepoOwnerName: string;
    githubRepoName: string;
    defaultBranch: string;
  } | null;
}

interface EASApp {
  id: string;
  name: string;
  slug: string;
  githubRepository: GitHubRepository | null;
}

type PlatformChoice = 'IOS' | 'ANDROID' | 'BOTH';

interface PartialResult {
  succeeded: EASBuild[];
  errors: { platform: string; message: string }[];
}

// ─── Skeleton card ────────────────────────────────────────────────────────────

function SkeletonCard({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[skeletonSt.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[skeletonSt.icon, { backgroundColor: colors.secondary }]} />
      <View style={skeletonSt.lines}>
        <View style={[skeletonSt.line, { width: '55%', backgroundColor: colors.secondary }]} />
        <View style={[skeletonSt.line, { width: '35%', backgroundColor: colors.secondary, opacity: 0.6 }]} />
        <View style={[skeletonSt.pill, { width: 56, backgroundColor: colors.secondary, opacity: 0.5 }]} />
      </View>
      <View style={[skeletonSt.dl, { backgroundColor: colors.secondary }]} />
    </View>
  );
}

const skeletonSt = StyleSheet.create({
  card:  { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: 1, padding: 14 },
  icon:  { width: 44, height: 44, borderRadius: 12 },
  lines: { flex: 1, gap: 7 },
  line:  { height: 11, borderRadius: 6 },
  pill:  { height: 20, borderRadius: 10 },
  dl:    { width: 36, height: 36, borderRadius: 10 },
});

// ─── Start Build Modal ────────────────────────────────────────────────────────

interface StartBuildModalProps {
  visible: boolean;
  colors: ReturnType<typeof useColors>;
  authToken: string;
  account: string;
  onClose: () => void;
  onBuildStarted: (builds: EASBuild[], partial: PartialResult) => void;
}

function StartBuildModal({
  visible, colors, authToken, account, onClose, onBuildStarted,
}: StartBuildModalProps) {
  const insets = useSafeAreaInsets();
  const ms = makeMStyles(colors);

  const [apps, setApps]               = useState<EASApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError]     = useState('');
  const [selectedApp, setSelectedApp] = useState<EASApp | null>(null);
  const [platform, setPlatform]       = useState<PlatformChoice>('IOS');
  const [buildProfile, setBuildProfile] = useState('production');
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Reset & load apps when modal opens
  useEffect(() => {
    if (!visible || !authToken) return;
    setApps([]);
    setSelectedApp(null);
    setAppsError('');
    setSubmitError('');
    setSubmitting(false);
    setBuildProfile('production');
    setPlatform('IOS');
    setAppsLoading(true);

    const base = resolveApiBaseUrl();
    fetch(`${base}/api/eas/apps`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => r.json())
      .then((json: { apps?: EASApp[]; error?: string }) => {
        if (json.error) throw new Error(json.error);
        const list = json.apps ?? [];
        setApps(list);
        if (list.length === 1) setSelectedApp(list[0]);
      })
      .catch((err) => setAppsError(err instanceof Error ? err.message : 'Failed to load projects'))
      .finally(() => setAppsLoading(false));
  }, [visible, authToken]);

  // ── Trigger one platform build via API server ──────────────────────────────
  const triggerOne = async (app: EASApp, plt: 'IOS' | 'ANDROID'): Promise<EASBuild> => {
    const base = resolveApiBaseUrl();
    const res = await fetch(`${base}/api/eas/builds/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ appId: app.id, platform: plt, buildProfile }),
    });
    const json = await res.json() as { build?: EASBuild; error?: string };
    if (!res.ok || json.error) throw new Error(json.error ?? `Server error ${res.status}`);
    if (!json.build) throw new Error('No build returned from server');
    return json.build;
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!selectedApp) return;
    setSubmitting(true);
    setSubmitError('');

    const platforms: Array<'IOS' | 'ANDROID'> =
      platform === 'BOTH' ? ['IOS', 'ANDROID'] : [platform];

    const settled = await Promise.allSettled(
      platforms.map((plt) => triggerOne(selectedApp, plt)),
    );

    const result: PartialResult = { succeeded: [], errors: [] };
    settled.forEach((s, i) => {
      const plt = platforms[i]!;
      if (s.status === 'fulfilled') {
        result.succeeded.push({
          ...s.value,
          status: s.value.status || 'IN_QUEUE',
          createdAt: s.value.createdAt || new Date().toISOString(),
          app: s.value.app || { name: selectedApp.name, slug: selectedApp.slug },
        });
      } else {
        const msg = s.reason instanceof Error ? s.reason.message : 'Unknown error';
        result.errors.push({ platform: plt, message: msg });
      }
    });

    setSubmitting(false);

    if (result.succeeded.length === 0) {
      const msgs = result.errors.map((e) =>
        platforms.length > 1
          ? `${e.platform === 'IOS' ? 'iOS' : 'Android'}: ${e.message}`
          : e.message,
      );
      setSubmitError(msgs.join('\n\n'));
    } else {
      onBuildStarted(result.succeeded, result);
      onClose();
    }
  };

  const noGitHub = selectedApp !== null && !selectedApp.githubRepository;

  const platformOptions: Array<{
    value: PlatformChoice;
    label: string;
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    color: string;
  }> = [
    { value: 'IOS',     label: 'iOS',     icon: 'apple',          color: PLATFORM_COLOR.IOS     },
    { value: 'ANDROID', label: 'Android', icon: 'android',        color: PLATFORM_COLOR.ANDROID },
    { value: 'BOTH',    label: 'Both',    icon: 'cellphone-link', color: colors.primary         },
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[ms.sheet, { backgroundColor: colors.background, paddingBottom: insets.bottom + 16 }]}>
        {/* Header */}
        <View style={[ms.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} hitSlop={12}>
            <MaterialCommunityIcons name="close" size={22} color={colors.mutedForeground} />
          </Pressable>
          <Text style={[ms.headerTitle, { color: colors.foreground }]}>Start Build</Text>
          <View style={{ width: 28 }} />
        </View>

        <ScrollView
          contentContainerStyle={ms.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Project selection */}
          <Text style={[ms.sectionLabel, { color: colors.mutedForeground }]}>PROJECT</Text>

          {appsLoading ? (
            <View style={[ms.infoBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[ms.infoText, { color: colors.mutedForeground }]}>Loading projects…</Text>
            </View>
          ) : appsError ? (
            <View style={[ms.errorBox, { backgroundColor: colors.destructive + '15', borderColor: colors.destructive + '40' }]}>
              <MaterialCommunityIcons name="alert-circle-outline" size={14} color={colors.destructive} />
              <Text style={[ms.errorText, { color: colors.destructive }]}>{appsError}</Text>
            </View>
          ) : apps.length === 0 ? (
            <View style={[ms.infoBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <MaterialCommunityIcons name="package-variant-closed" size={18} color={colors.mutedForeground} />
              <Text style={[ms.infoText, { color: colors.mutedForeground }]}>
                No EAS projects found for @{account}
              </Text>
            </View>
          ) : (
            apps.map((app) => {
              const selected = selectedApp?.id === app.id;
              const hasGitHub = !!app.githubRepository;
              return (
                <Pressable
                  key={app.id}
                  style={[
                    ms.appRow,
                    {
                      backgroundColor: selected ? colors.primary + '12' : colors.card,
                      borderColor: selected ? colors.primary + '80' : colors.border,
                    },
                  ]}
                  onPress={() => { setSelectedApp(app); setSubmitError(''); }}
                >
                  <View style={[ms.appIcon, { backgroundColor: colors.primary + '18' }]}>
                    <Text style={[ms.appInitials, { color: colors.primary }]}>
                      {initials(app.name || app.slug)}
                    </Text>
                  </View>
                  <View style={ms.appMeta}>
                    <Text style={[ms.appName, { color: colors.foreground }]} numberOfLines={1}>
                      {app.name || app.slug}
                    </Text>
                    <View style={ms.appSubRow}>
                      <Text style={[ms.appSlug, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {app.slug}
                      </Text>
                      {hasGitHub ? (
                        <View style={ms.ghPill}>
                          <MaterialCommunityIcons name="github" size={10} color={colors.mutedForeground} />
                          <Text style={[ms.ghPillText, { color: colors.mutedForeground }]}>
                            {app.githubRepository?.metadata?.githubRepoName ?? 'linked'}
                          </Text>
                        </View>
                      ) : (
                        <View style={[ms.ghPill, { backgroundColor: colors.warning + '18' }]}>
                          <MaterialCommunityIcons name="github" size={10} color={colors.warning} />
                          <Text style={[ms.ghPillText, { color: colors.warning }]}>No GitHub</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  {selected && (
                    <MaterialCommunityIcons name="check-circle" size={18} color={colors.primary} />
                  )}
                </Pressable>
              );
            })
          )}

          {/* No-GitHub warning */}
          {noGitHub ? (
            <View style={[ms.warnBox, { backgroundColor: colors.warning + '15', borderColor: colors.warning + '40' }]}>
              <MaterialCommunityIcons name="github" size={14} color={colors.warning} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={[ms.warnTitle, { color: colors.warning }]}>No GitHub repo linked</Text>
                <Text style={[ms.warnSub, { color: colors.warning + 'cc' }]}>
                  Remote builds require a connected GitHub repo. Link one on expo.dev → Project → GitHub.
                </Text>
                <Pressable
                  style={{ marginTop: 6 }}
                  onPress={() => Linking.openURL(`https://expo.dev/accounts/${account}/projects/${selectedApp?.slug}/github`)}
                >
                  <Text style={[ms.linkText, { color: colors.info }]}>Connect on expo.dev →</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* Platform picker */}
          <Text style={[ms.sectionLabel, { color: colors.mutedForeground, marginTop: 22 }]}>PLATFORM</Text>
          <View style={ms.platformRow}>
            {platformOptions.map((opt) => {
              const active = platform === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[
                    ms.platformChip,
                    {
                      backgroundColor: active ? opt.color + '18' : colors.card,
                      borderColor: active ? opt.color + '80' : colors.border,
                      flex: 1,
                    },
                  ]}
                  onPress={() => setPlatform(opt.value)}
                >
                  <MaterialCommunityIcons
                    name={opt.icon}
                    size={18}
                    color={active ? opt.color : colors.mutedForeground}
                  />
                  <Text style={[
                    ms.platformChipLabel,
                    { color: active ? opt.color : colors.mutedForeground, fontWeight: active ? '700' : '500' },
                  ]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Build profile */}
          <Text style={[ms.sectionLabel, { color: colors.mutedForeground, marginTop: 22 }]}>BUILD PROFILE</Text>
          <TextInput
            style={[ms.profileInput, {
              backgroundColor: colors.input,
              borderColor: colors.border,
              color: colors.foreground,
            }]}
            placeholder="production"
            placeholderTextColor={colors.mutedForeground}
            value={buildProfile}
            onChangeText={(t) => { setBuildProfile(t); setSubmitError(''); }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
          />
          <Text style={[ms.profileHint, { color: colors.mutedForeground }]}>
            Must match a profile in your project's eas.json (e.g. production, preview, development)
          </Text>

          {/* Submit error */}
          {submitError ? (
            <View style={[ms.errorBox, { backgroundColor: colors.destructive + '15', borderColor: colors.destructive + '40', marginTop: 14 }]}>
              <MaterialCommunityIcons name="alert-circle-outline" size={14} color={colors.destructive} style={{ marginTop: 1 }} />
              <Text style={[ms.errorText, { color: colors.destructive }]}>{submitError}</Text>
            </View>
          ) : null}

          {/* Info note */}
          <View style={[ms.noteBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <MaterialCommunityIcons name="information-outline" size={13} color={colors.mutedForeground} />
            <Text style={[ms.noteText, { color: colors.mutedForeground }]}>
              EAS fetches source from the default branch of your linked GitHub repo and builds using stored credentials.
            </Text>
          </View>
        </ScrollView>

        {/* Footer CTA */}
        <View style={[ms.footer, { borderTopColor: colors.border }]}>
          <Pressable
            style={[ms.startBtn, {
              backgroundColor: colors.primary,
              opacity: submitting || !selectedApp || !buildProfile.trim() || noGitHub ? 0.5 : 1,
            }]}
            onPress={handleStart}
            disabled={submitting || !selectedApp || !buildProfile.trim() || noGitHub}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialCommunityIcons name="rocket-launch-outline" size={18} color="#fff" />
            )}
            <Text style={ms.startBtnText}>
              {submitting
                ? (platform === 'BOTH' ? 'Queuing both builds…' : 'Queuing build…')
                : platform === 'BOTH'
                  ? 'Start iOS + Android builds'
                  : `Start ${platform === 'IOS' ? 'iOS' : 'Android'} build`}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function makeMStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    sheet: { flex: 1 },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
    },
    headerTitle: { fontSize: 16, fontWeight: '700' },
    body: { padding: 16, paddingTop: 20 },
    sectionLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
    infoBox: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      borderRadius: 12, borderWidth: 1,
      paddingHorizontal: 14, paddingVertical: 14, marginBottom: 4,
    },
    infoText: { fontSize: 13 },
    appRow: {
      flexDirection: 'row', alignItems: 'center', gap: 11,
      borderRadius: 12, borderWidth: 1,
      paddingHorizontal: 13, paddingVertical: 11, marginBottom: 7,
    },
    appIcon: {
      width: 36, height: 36, borderRadius: 9,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    appInitials: { fontSize: 13, fontWeight: '800' },
    appMeta: { flex: 1 },
    appName: { fontSize: 14, fontWeight: '600' },
    appSubRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
    appSlug: { fontSize: 11 },
    ghPill: {
      flexDirection: 'row', alignItems: 'center', gap: 3,
      borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2,
    },
    ghPillText: { fontSize: 10 },
    warnBox: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 8,
      borderWidth: 1, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 11, marginTop: 4, marginBottom: 4,
    },
    warnTitle: { fontSize: 12, fontWeight: '600', marginBottom: 2 },
    warnSub: { fontSize: 11, lineHeight: 16 },
    linkText: { fontSize: 11, fontWeight: '600' },
    platformRow: { flexDirection: 'row', gap: 8 },
    platformChip: {
      flexDirection: 'column', alignItems: 'center', gap: 5,
      borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 8,
    },
    platformChipLabel: { fontSize: 12 },
    profileInput: {
      borderWidth: 1, borderRadius: 10,
      paddingHorizontal: 14, paddingVertical: 13, fontSize: 14,
    },
    profileHint: { fontSize: 11, marginTop: 5, lineHeight: 16 },
    errorBox: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 7,
      borderWidth: 1, borderRadius: 8, padding: 10,
    },
    errorText: { fontSize: 12, lineHeight: 18, flex: 1 },
    noteBox: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 8,
      borderWidth: 1, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 11, marginTop: 18,
    },
    noteText: { fontSize: 11, lineHeight: 17, flex: 1 },
    footer: { paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1 },
    startBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 9, borderRadius: 12, paddingVertical: 16,
    },
    startBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  });
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EASBuildsScreen() {
  const colors  = useColors();
  const insets  = useSafeAreaInsets();
  const s       = makeStyles(colors);
  const { token: authToken } = useAuth();

  const [builds,       setBuilds]       = useState<EASBuild[]>([]);
  const [account,      setAccount]      = useState('');
  const [username,     setUsername]     = useState('');
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [refreshing,   setRefreshing]   = useState(false);
  const [partialError, setPartialError] = useState('');
  const [showModal,    setShowModal]    = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch via API server (uses EAS_CLOWNIN_KEY server-side) ───────────────

  const fetchBuilds = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const base = resolveApiBaseUrl();
      const res  = await fetch(`${base}/api/eas/builds`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const json = await res.json() as {
        builds?: EASBuild[];
        account?: string;
        username?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `Server error ${res.status}`);
      setBuilds(json.builds ?? []);
      if (json.account)  setAccount(json.account);
      if (json.username) setUsername(json.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load builds');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authToken]);

  // ── Load on mount ──────────────────────────────────────────────────────────

  useEffect(() => { fetchBuilds(); }, [fetchBuilds]);

  // ── Poll while builds are active ───────────────────────────────────────────

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const hasActive = builds.some(
      (b) => b.status === 'IN_PROGRESS' || b.status === 'IN_QUEUE' || b.status === 'NEW',
    );
    if (hasActive) {
      pollRef.current = setInterval(() => fetchBuilds(true), 12_000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [builds, fetchBuilds]);

  // ── Build started callback ─────────────────────────────────────────────────

  const handleBuildStarted = useCallback((newBuilds: EASBuild[], partial: PartialResult) => {
    setBuilds((prev) => [...newBuilds, ...prev]);
    setPartialError('');
    if (partial.errors.length > 0) {
      const msgs = partial.errors
        .map((e) => `${e.platform === 'IOS' ? 'iOS' : 'Android'}: ${e.message}`)
        .join('\n');
      setPartialError(msgs);
    }
    // Re-fetch after a short delay to sync real statuses from EAS
    setTimeout(() => fetchBuilds(true), 4_000);
  }, [fetchBuilds]);

  // ── Build card ─────────────────────────────────────────────────────────────

  const renderBuild = useCallback(({ item }: { item: EASBuild }) => {
    const statusColor  = STATUS_COLOR[item.status]  ?? '#6e7681';
    const statusLabel  = STATUS_LABEL[item.status]  ?? item.status;
    const platIcon     = PLATFORM_ICON[item.platform]  ?? 'help-circle-outline';
    const platColor    = PLATFORM_COLOR[item.platform] ?? colors.mutedForeground;
    const platLabel    = PLATFORM_LABEL[item.platform] ?? item.platform;
    const isActive     = item.status === 'IN_PROGRESS' || item.status === 'IN_QUEUE' || item.status === 'NEW';
    const buildUrl     = item.artifacts?.buildUrl;
    const appLabel     = item.app?.name || item.app?.slug || '—';

    return (
      <View style={[
        s.buildCard,
        { borderColor: isActive ? statusColor + '55' : colors.border },
        isActive && { borderLeftColor: statusColor, borderLeftWidth: 3 },
      ]}>
        <View style={[s.platformBadge, { backgroundColor: platColor + '18' }]}>
          <MaterialCommunityIcons name={platIcon} size={22} color={platColor} />
        </View>

        <View style={s.buildInfo}>
          <View style={s.buildTopRow}>
            <Text style={[s.buildAppName, { color: colors.foreground }]} numberOfLines={1}>
              {appLabel}
            </Text>
            <Text style={[s.buildAge, { color: colors.mutedForeground }]}>
              {timeAgo(item.createdAt)}
            </Text>
          </View>
          <Text style={[s.buildPlatLabel, { color: colors.mutedForeground }]}>{platLabel}</Text>
          <View style={[s.statusPill, { backgroundColor: statusColor + '1a' }]}>
            {isActive
              ? <ActivityIndicator size={9} color={statusColor} style={{ marginRight: 4 }} />
              : <View style={[s.statusDot, { backgroundColor: statusColor }]} />
            }
            <Text style={[s.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>

        {buildUrl ? (
          <Pressable
            style={[s.dlBtn, { backgroundColor: colors.success + '1a' }]}
            onPress={() => Linking.openURL(buildUrl)}
            hitSlop={8}
          >
            <MaterialCommunityIcons name="download-outline" size={20} color={colors.success} />
          </Pressable>
        ) : (
          <View style={{ width: 36 }} />
        )}
      </View>
    );
  }, [colors, s]);

  // ── Nav bar (shared) ───────────────────────────────────────────────────────

  const acctInitials = initials(username || account);

  const NavBar = (
    <View style={s.navBar}>
      <Pressable onPress={() => router.back()} hitSlop={12}>
        <MaterialCommunityIcons name="arrow-left" size={22} color={colors.foreground} />
      </Pressable>
      <View style={s.navMid}>
        <Text style={[s.navTitle, { color: colors.foreground }]}>EAS Builds</Text>
        {account ? (
          <View style={s.accountPill}>
            <View style={[s.avatarDot, { backgroundColor: colors.primary }]}>
              <Text style={s.avatarText}>{acctInitials}</Text>
            </View>
            <Text style={[s.accountName, { color: colors.mutedForeground }]}>
              @{username || account}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={s.navActions}>
        <Pressable
          style={[s.startBuildNavBtn, { backgroundColor: colors.primary }]}
          onPress={() => { setPartialError(''); setShowModal(true); }}
          hitSlop={6}
        >
          <MaterialCommunityIcons name="plus" size={15} color="#fff" />
          <Text style={s.startBuildNavLabel}>Build</Text>
        </Pressable>
        <Pressable onPress={() => fetchBuilds()} hitSlop={12} disabled={loading} style={{ marginLeft: 8 }}>
          <MaterialCommunityIcons
            name="refresh"
            size={20}
            color={loading ? colors.mutedForeground : colors.foreground}
          />
        </Pressable>
      </View>
    </View>
  );

  // ── Loading (first fetch) ──────────────────────────────────────────────────

  if (loading && builds.length === 0) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        {NavBar}
        <ScrollView contentContainerStyle={s.list}>
          {[0, 1, 2].map((i) => <SkeletonCard key={i} colors={colors} />)}
        </ScrollView>
      </View>
    );
  }

  // ── Error (nothing loaded yet) ─────────────────────────────────────────────

  if (error && builds.length === 0) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        {NavBar}
        <View style={s.center}>
          <View style={[s.stateIcon, { backgroundColor: colors.destructive + '18' }]}>
            <MaterialCommunityIcons name="alert-circle-outline" size={32} color={colors.destructive} />
          </View>
          <Text style={[s.stateTitle, { color: colors.foreground }]}>Couldn't load builds</Text>
          <Text style={[s.stateBody, { color: colors.mutedForeground }]}>{error}</Text>
          <Pressable style={[s.retryBtn, { backgroundColor: colors.primary }]} onPress={() => fetchBuilds()}>
            <MaterialCommunityIcons name="refresh" size={15} color="#fff" />
            <Text style={s.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Empty ──────────────────────────────────────────────────────────────────

  if (!loading && builds.length === 0) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        {NavBar}
        <View style={s.center}>
          <View style={[s.stateIcon, { backgroundColor: colors.secondary }]}>
            <MaterialCommunityIcons name="package-variant-closed" size={34} color={colors.mutedForeground} />
          </View>
          <Text style={[s.stateTitle, { color: colors.foreground }]}>No builds yet</Text>
          <Text style={[s.stateBody, { color: colors.mutedForeground }]}>
            Tap <Text style={{ color: colors.foreground, fontWeight: '700' }}>Build</Text> above to queue
            your first build, or run{' '}
            <Text style={{ color: colors.foreground, fontFamily: 'monospace' }}>eas build</Text> from your terminal.
          </Text>
          <Pressable
            style={[s.startBuildEmptyBtn, { backgroundColor: colors.primary }]}
            onPress={() => setShowModal(true)}
          >
            <MaterialCommunityIcons name="rocket-launch-outline" size={16} color="#fff" />
            <Text style={s.startBuildEmptyLabel}>Start first build</Text>
          </Pressable>
          <Pressable
            style={[s.docsBtn, { borderColor: colors.border }]}
            onPress={() => Linking.openURL('https://docs.expo.dev/build/introduction/')}
          >
            <MaterialCommunityIcons name="book-open-outline" size={15} color={colors.info} />
            <Text style={[s.docsBtnText, { color: colors.info }]}>EAS Build docs</Text>
          </Pressable>
        </View>
        <StartBuildModal
          visible={showModal}
          colors={colors}
          authToken={authToken ?? ''}
          account={account}
          onClose={() => setShowModal(false)}
          onBuildStarted={handleBuildStarted}
        />
      </View>
    );
  }

  // ── Builds list ────────────────────────────────────────────────────────────

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {NavBar}
      <FlatList
        data={builds}
        keyExtractor={(b) => b.id}
        renderItem={renderBuild}
        contentContainerStyle={s.list}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchBuilds(true); }}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <>
            {partialError ? (
              <View style={[s.warnBanner, { backgroundColor: colors.warning + '18', borderColor: colors.warning + '44' }]}>
                <MaterialCommunityIcons name="alert-outline" size={14} color={colors.warning} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.warnText, { color: colors.warning, fontWeight: '600' }]}>
                    One platform failed to queue
                  </Text>
                  <Text style={[s.warnText, { color: colors.warning }]}>{partialError}</Text>
                </View>
                <Pressable onPress={() => setPartialError('')} hitSlop={8}>
                  <MaterialCommunityIcons name="close" size={14} color={colors.warning} />
                </Pressable>
              </View>
            ) : null}
            {error ? (
              <View style={[s.warnBanner, { backgroundColor: colors.warning + '18', borderColor: colors.warning + '44' }]}>
                <MaterialCommunityIcons name="alert-outline" size={14} color={colors.warning} />
                <Text style={[s.warnText, { color: colors.warning }]}>{error}</Text>
              </View>
            ) : null}
          </>
        }
        ListFooterComponent={<View style={{ height: 32 }} />}
      />
      <StartBuildModal
        visible={showModal}
        colors={colors}
        authToken={authToken ?? ''}
        account={account}
        onClose={() => setShowModal(false)}
        onBuildStarted={handleBuildStarted}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },

    navBar: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 13,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    navMid: { flex: 1, alignItems: 'center', gap: 4 },
    navTitle: { fontSize: 15, fontWeight: '700', letterSpacing: 0.1 },
    accountPill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    avatarDot: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontSize: 9, fontWeight: '800', color: '#fff' },
    accountName: { fontSize: 12 },
    navActions: { flexDirection: 'row', alignItems: 'center' },
    startBuildNavBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    },
    startBuildNavLabel: { color: '#fff', fontSize: 12, fontWeight: '700' },

    // List
    list: { padding: 12, paddingTop: 14 },
    buildCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 14,
      borderWidth: 1, padding: 13, paddingLeft: 12,
    },
    platformBadge: {
      width: 44, height: 44, borderRadius: 12,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    buildInfo: { flex: 1, gap: 4 },
    buildTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    buildAppName: { fontSize: 14, fontWeight: '700', flex: 1 },
    buildAge: { fontSize: 11, flexShrink: 0, marginLeft: 6 },
    buildPlatLabel: { fontSize: 12 },
    statusPill: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingHorizontal: 8, paddingVertical: 3,
      borderRadius: 20, alignSelf: 'flex-start',
    },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusText: { fontSize: 11, fontWeight: '700' },
    dlBtn: {
      width: 36, height: 36, borderRadius: 10,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },

    // States
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 36, gap: 10 },
    stateIcon: { width: 68, height: 68, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    stateTitle: { fontSize: 18, fontWeight: '700' },
    stateBody: { fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 2 },
    startBuildEmptyBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderRadius: 11, paddingHorizontal: 22, paddingVertical: 13, marginTop: 8,
    },
    startBuildEmptyLabel: { color: '#fff', fontWeight: '700', fontSize: 14 },
    retryBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      borderRadius: 10, paddingHorizontal: 22, paddingVertical: 11, marginTop: 8,
    },
    retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    docsBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderWidth: 1, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10, marginTop: 4,
    },
    docsBtnText: { fontSize: 13, fontWeight: '600' },

    // Warning banners
    warnBanner: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 7,
      borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 10,
    },
    warnText: { fontSize: 12, lineHeight: 18, flex: 1 },
  });
}
