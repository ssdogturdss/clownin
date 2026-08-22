import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Linking,
  ScrollView,
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

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EASBuildsScreen() {
  const colors  = useColors();
  const insets  = useSafeAreaInsets();
  const s       = makeStyles(colors);
  const { token: authToken } = useAuth();

  const [builds,     setBuilds]     = useState<EASBuild[]>([]);
  const [account,    setAccount]    = useState('');
  const [username,   setUsername]   = useState('');
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [refreshing, setRefreshing] = useState(false);

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
        {/* Platform badge */}
        <View style={[s.platformBadge, { backgroundColor: platColor + '18' }]}>
          <MaterialCommunityIcons name={platIcon} size={22} color={platColor} />
        </View>

        {/* Info */}
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

        {/* Download */}
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
      {/* Refresh button */}
      <Pressable onPress={() => fetchBuilds()} hitSlop={12} disabled={loading}>
        <MaterialCommunityIcons
          name="refresh"
          size={20}
          color={loading ? colors.mutedForeground : colors.foreground}
        />
      </Pressable>
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
            Run <Text style={{ color: colors.foreground, fontFamily: 'monospace' }}>eas build</Text> from your terminal to queue one.
          </Text>
          <Pressable
            style={[s.docsBtn, { borderColor: colors.border }]}
            onPress={() => Linking.openURL('https://docs.expo.dev/build/introduction/')}
          >
            <MaterialCommunityIcons name="book-open-outline" size={15} color={colors.info} />
            <Text style={[s.docsBtnText, { color: colors.info }]}>EAS Build docs</Text>
          </Pressable>
        </View>
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
          error ? (
            <View style={[s.warnBanner, { backgroundColor: colors.warning + '18', borderColor: colors.warning + '44' }]}>
              <MaterialCommunityIcons name="alert-outline" size={14} color={colors.warning} />
              <Text style={[s.warnText, { color: colors.warning }]}>{error}</Text>
            </View>
          ) : null
        }
        ListFooterComponent={<View style={{ height: 32 }} />}
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
    retryBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      borderRadius: 10, paddingHorizontal: 22, paddingVertical: 11, marginTop: 8,
    },
    retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    docsBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderWidth: 1, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10, marginTop: 10,
    },
    docsBtnText: { fontSize: 13, fontWeight: '600' },

    // Warning banner
    warnBanner: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 7,
      borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 10,
    },
    warnText: { fontSize: 12, lineHeight: 18, flex: 1 },
  });
}
