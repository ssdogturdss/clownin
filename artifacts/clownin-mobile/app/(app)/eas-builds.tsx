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
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

// ─── Storage keys ─────────────────────────────────────────────────────────────

const TOKEN_KEY = 'clownin_expo_token';
const ACCOUNT_KEY = 'clownin_expo_account';
const USERNAME_KEY = 'clownin_expo_username';
const EAS_GQL = 'https://api.expo.dev/graphql';

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
  IOS:     '#a8b2bf',  // Apple silver
  ANDROID: '#3ddc84',  // Android green
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

async function easQuery<T = unknown>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(EAS_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`EAS API ${res.status}: ${res.statusText}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const VIEWER_QUERY = `
  query ClowninViewer {
    viewer {
      id
      username
      accounts { id name }
    }
  }
`;

const BUILDS_QUERY = `
  query ClowninBuilds($accountName: String!, $first: Int!) {
    account {
      byName(accountName: $accountName) {
        builds(first: $first) {
          edges {
            node {
              id
              status
              platform
              createdAt
              expirationDate
              app { name slug }
              artifacts { buildUrl }
            }
          }
        }
      }
    }
  }
`;

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
    <View style={[skeletonStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[skeletonStyles.icon, { backgroundColor: colors.secondary }]} />
      <View style={skeletonStyles.lines}>
        <View style={[skeletonStyles.line, { width: '55%', backgroundColor: colors.secondary }]} />
        <View style={[skeletonStyles.line, { width: '35%', backgroundColor: colors.secondary, opacity: 0.6 }]} />
        <View style={[skeletonStyles.pill, { width: 56, backgroundColor: colors.secondary, opacity: 0.5 }]} />
      </View>
      <View style={[skeletonStyles.dl, { backgroundColor: colors.secondary }]} />
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14,
  },
  icon:  { width: 44, height: 44, borderRadius: 12 },
  lines: { flex: 1, gap: 7 },
  line:  { height: 11, borderRadius: 6 },
  pill:  { height: 20, borderRadius: 10 },
  dl:    { width: 36, height: 36, borderRadius: 10 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EASBuildsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const s = makeStyles(colors);

  const [token,    setToken]    = useState('');
  const [inputToken, setInputToken] = useState('');
  const [account,  setAccount]  = useState('');
  const [username, setUsername] = useState('');

  const [builds,     setBuilds]     = useState<EASBuild[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error,      setError]      = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Restore saved session ──────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const [t, acc, uname] = await Promise.all([
        AsyncStorage.getItem(TOKEN_KEY),
        AsyncStorage.getItem(ACCOUNT_KEY),
        AsyncStorage.getItem(USERNAME_KEY),
      ]);
      if (t && acc) {
        setToken(t);
        setAccount(acc);
        setUsername(uname ?? acc);
      }
    })();
  }, []);

  // ── Fetch builds ───────────────────────────────────────────────────────────

  const fetchBuilds = useCallback(async (tok: string, acc: string, silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const data = await easQuery<{
        account: { byName: { builds: { edges: { node: EASBuild }[] } } };
      }>(tok, BUILDS_QUERY, { accountName: acc, first: 40 });

      const list = (data.account?.byName?.builds?.edges ?? []).map((e) => e.node);
      setBuilds(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load builds');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // ── Auto-fetch on mount when token exists ──────────────────────────────────

  useEffect(() => {
    if (!token || !account) return;
    fetchBuilds(token, account);
  }, [token, account, fetchBuilds]);

  // ── Poll while builds are active ───────────────────────────────────────────

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const hasActive = builds.some(
      (b) => b.status === 'IN_PROGRESS' || b.status === 'IN_QUEUE' || b.status === 'NEW',
    );
    if (hasActive && token && account) {
      pollRef.current = setInterval(() => fetchBuilds(token, account, true), 12_000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [builds, token, account, fetchBuilds]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const handleConnect = useCallback(async () => {
    const tok = inputToken.trim();
    if (!tok) return;
    setConnecting(true);
    setError('');
    try {
      const data = await easQuery<{
        viewer: { id: string; username: string; accounts: { id: string; name: string }[] };
      }>(tok, VIEWER_QUERY);

      const acc   = data.viewer?.accounts?.[0]?.name;
      const uname = data.viewer?.username;
      if (!acc) throw new Error('No Expo account found for this token');

      await AsyncStorage.multiSet([
        [TOKEN_KEY,    tok],
        [ACCOUNT_KEY,  acc],
        [USERNAME_KEY, uname ?? acc],
      ]);
      setToken(tok);
      setAccount(acc);
      setUsername(uname ?? acc);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }, [inputToken]);

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const handleDisconnect = useCallback(() => {
    Alert.alert('Disconnect Expo', `Signed in as @${username || account}. Remove this token?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect', style: 'destructive',
        onPress: async () => {
          await AsyncStorage.multiRemove([TOKEN_KEY, ACCOUNT_KEY, USERNAME_KEY]);
          setToken(''); setAccount(''); setUsername('');
          setBuilds([]); setInputToken('');
        },
      },
    ]);
  }, [username, account]);

  // ── Build card ─────────────────────────────────────────────────────────────

  const renderBuild = useCallback(
    ({ item }: { item: EASBuild }) => {
      const statusColor = STATUS_COLOR[item.status] ?? '#6e7681';
      const statusLabel = STATUS_LABEL[item.status] ?? item.status;
      const platformIcon  = PLATFORM_ICON[item.platform]  ?? 'help-circle-outline';
      const platformColor = PLATFORM_COLOR[item.platform] ?? colors.mutedForeground;
      const platformLabel = PLATFORM_LABEL[item.platform] ?? item.platform;
      const isActive  = item.status === 'IN_PROGRESS' || item.status === 'IN_QUEUE' || item.status === 'NEW';
      const buildUrl  = item.artifacts?.buildUrl;
      const appLabel  = item.app?.name || item.app?.slug || '—';

      return (
        <View style={[
          s.buildCard,
          { borderColor: isActive ? statusColor + '55' : colors.border },
          isActive && { borderLeftColor: statusColor, borderLeftWidth: 3 },
        ]}>
          {/* Platform badge */}
          <View style={[s.platformBadge, { backgroundColor: platformColor + '18' }]}>
            <MaterialCommunityIcons name={platformIcon} size={22} color={platformColor} />
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

            <Text style={[s.buildPlatformLabel, { color: colors.mutedForeground }]}>
              {platformLabel}
            </Text>

            {/* Status pill */}
            <View style={[s.statusPill, { backgroundColor: statusColor + '1a' }]}>
              {isActive
                ? <ActivityIndicator size={9} color={statusColor} style={{ marginRight: 4 }} />
                : <View style={[s.statusDot, { backgroundColor: statusColor }]} />
              }
              <Text style={[s.statusText, { color: statusColor }]}>{statusLabel}</Text>
            </View>
          </View>

          {/* Download / open */}
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
    },
    [colors, s],
  );

  // ── Connect screen ─────────────────────────────────────────────────────────

  if (!token) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.navBar}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <MaterialCommunityIcons name="arrow-left" size={22} color={colors.foreground} />
          </Pressable>
          <Text style={[s.navTitle, { color: colors.foreground }]}>EAS Builds</Text>
          <View style={{ width: 28 }} />
        </View>

        <ScrollView
          contentContainerStyle={s.connectBody}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Hero */}
          <View style={[s.heroBadge, { backgroundColor: colors.primary + '18', borderColor: colors.primary + '33' }]}>
            <MaterialCommunityIcons name="cellphone-arrow-down" size={44} color={colors.primary} />
          </View>
          <Text style={[s.connectTitle, { color: colors.foreground }]}>EAS Build Status</Text>
          <Text style={[s.connectSubtitle, { color: colors.mutedForeground }]}>
            Connect your Expo account once to track builds, see logs, and download artifacts — right here in the app.
          </Text>

          {/* Feature bullets */}
          {[
            { icon: 'list-status' as const,         label: 'Live build queue with auto-refresh' },
            { icon: 'download-outline' as const,    label: 'Download .ipa and .apk directly'   },
            { icon: 'shield-lock-outline' as const, label: 'Token stored on-device only'        },
          ].map((f) => (
            <View key={f.label} style={s.featureRow}>
              <View style={[s.featureIcon, { backgroundColor: colors.primary + '18' }]}>
                <MaterialCommunityIcons name={f.icon} size={16} color={colors.primary} />
              </View>
              <Text style={[s.featureLabel, { color: colors.mutedForeground }]}>{f.label}</Text>
            </View>
          ))}

          {/* Divider */}
          <View style={[s.divider, { backgroundColor: colors.border }]} />

          {/* Get token link */}
          <Pressable
            style={[s.getTokenBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => Linking.openURL('https://expo.dev/settings/access-tokens')}
          >
            <MaterialCommunityIcons name="key-outline" size={16} color={colors.info} />
            <Text style={[s.getTokenLabel, { color: colors.info }]}>Create a token on expo.dev →</Text>
          </Pressable>

          {/* Input */}
          <Text style={[s.fieldLabel, { color: colors.mutedForeground }]}>ACCESS TOKEN</Text>
          <TextInput
            style={[s.tokenInput, {
              backgroundColor: colors.input,
              borderColor: error ? colors.destructive : colors.border,
              color: colors.foreground,
            }]}
            placeholder="expo_…"
            placeholderTextColor={colors.mutedForeground}
            value={inputToken}
            onChangeText={(t) => { setInputToken(t); setError(''); }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={handleConnect}
            returnKeyType="done"
          />

          {error ? (
            <View style={[s.errorBox, { backgroundColor: colors.destructive + '15', borderColor: colors.destructive + '40' }]}>
              <MaterialCommunityIcons name="alert-circle-outline" size={14} color={colors.destructive} />
              <Text style={[s.errorBoxText, { color: colors.destructive }]}>{error}</Text>
            </View>
          ) : null}

          {/* CTA */}
          <Pressable
            style={[s.connectBtn, {
              backgroundColor: colors.primary,
              opacity: connecting || !inputToken.trim() ? 0.5 : 1,
            }]}
            onPress={handleConnect}
            disabled={connecting || !inputToken.trim()}
          >
            {connecting
              ? <ActivityIndicator size="small" color="#fff" />
              : <MaterialCommunityIcons name="connection" size={18} color="#fff" />
            }
            <Text style={s.connectBtnText}>{connecting ? 'Connecting…' : 'Connect account'}</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // ── Builds screen ──────────────────────────────────────────────────────────

  const accountInitials = initials(username || account);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Nav */}
      <View style={s.navBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialCommunityIcons name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>

        <View style={s.navMid}>
          <Text style={[s.navTitle, { color: colors.foreground }]}>EAS Builds</Text>
          {account ? (
            <View style={s.accountPill}>
              <View style={[s.avatarDot, { backgroundColor: colors.primary }]}>
                <Text style={s.avatarText}>{accountInitials}</Text>
              </View>
              <Text style={[s.accountName, { color: colors.mutedForeground }]}>
                @{username || account}
              </Text>
            </View>
          ) : null}
        </View>

        <Pressable onPress={handleDisconnect} hitSlop={12}>
          <MaterialCommunityIcons name="logout-variant" size={20} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* Content */}
      {loading && builds.length === 0 ? (
        <ScrollView contentContainerStyle={s.list}>
          {[0, 1, 2].map((i) => <SkeletonCard key={i} colors={colors} />)}
        </ScrollView>
      ) : error && builds.length === 0 ? (
        <View style={s.center}>
          <View style={[s.errorIcon, { backgroundColor: colors.destructive + '18' }]}>
            <MaterialCommunityIcons name="alert-circle-outline" size={32} color={colors.destructive} />
          </View>
          <Text style={[s.emptyTitle, { color: colors.foreground }]}>Couldn't load builds</Text>
          <Text style={[s.emptyBody, { color: colors.mutedForeground }]}>{error}</Text>
          <Pressable
            style={[s.retryBtn, { backgroundColor: colors.primary }]}
            onPress={() => fetchBuilds(token, account)}
          >
            <MaterialCommunityIcons name="refresh" size={15} color="#fff" />
            <Text style={s.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : builds.length === 0 ? (
        <View style={s.center}>
          <View style={[s.emptyIcon, { backgroundColor: colors.secondary }]}>
            <MaterialCommunityIcons name="package-variant-closed" size={36} color={colors.mutedForeground} />
          </View>
          <Text style={[s.emptyTitle, { color: colors.foreground }]}>No builds yet</Text>
          <Text style={[s.emptyBody, { color: colors.mutedForeground }]}>
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
      ) : (
        <FlatList
          data={builds}
          keyExtractor={(b) => b.id}
          renderItem={renderBuild}
          contentContainerStyle={s.list}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchBuilds(token, account); }}
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
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },

    // Nav
    navBar: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 13,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    navMid: { flex: 1, alignItems: 'center', gap: 4 },
    navTitle: { fontSize: 15, fontWeight: '700', letterSpacing: 0.1 },
    accountPill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    avatarDot: {
      width: 16, height: 16, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center',
    },
    avatarText: { fontSize: 9, fontWeight: '800', color: '#fff' },
    accountName: { fontSize: 12 },

    // Connect screen
    connectBody: { padding: 24, paddingTop: 36, alignItems: 'center' },
    heroBadge: {
      width: 88, height: 88, borderRadius: 28, borderWidth: 1,
      alignItems: 'center', justifyContent: 'center', marginBottom: 22,
    },
    connectTitle: { fontSize: 23, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
    connectSubtitle: { fontSize: 14, lineHeight: 22, textAlign: 'center', marginBottom: 24 },
    featureRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      alignSelf: 'stretch', marginBottom: 10,
    },
    featureIcon: {
      width: 30, height: 30, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center',
    },
    featureLabel: { fontSize: 13 },
    divider: { height: 1, alignSelf: 'stretch', marginVertical: 22 },
    getTokenBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      alignSelf: 'stretch', borderWidth: 1, borderRadius: 10,
      paddingHorizontal: 14, paddingVertical: 11, marginBottom: 20,
    },
    getTokenLabel: { fontSize: 13, fontWeight: '600' },
    fieldLabel: {
      alignSelf: 'flex-start', fontSize: 10, fontWeight: '700',
      letterSpacing: 0.8, marginBottom: 7,
    },
    tokenInput: {
      alignSelf: 'stretch', borderWidth: 1, borderRadius: 10,
      paddingHorizontal: 14, paddingVertical: 13,
      fontSize: 14, letterSpacing: 0.5,
    },
    errorBox: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 7,
      borderWidth: 1, borderRadius: 8,
      padding: 10, marginTop: 8, alignSelf: 'stretch',
    },
    errorBoxText: { fontSize: 12, lineHeight: 18, flex: 1 },
    connectBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 8, borderRadius: 11, paddingVertical: 15,
      alignSelf: 'stretch', marginTop: 16,
    },
    connectBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

    // Builds list
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
    buildPlatformLabel: { fontSize: 12 },
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

    // Empty / error states
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 36, gap: 10 },
    emptyIcon: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    errorIcon: { width: 64, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    emptyTitle: { fontSize: 18, fontWeight: '700' },
    emptyBody: { fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 2 },
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
      borderWidth: 1, borderRadius: 8,
      padding: 10, marginBottom: 10,
    },
    warnText: { fontSize: 12, lineHeight: 18, flex: 1 },
  });
}
