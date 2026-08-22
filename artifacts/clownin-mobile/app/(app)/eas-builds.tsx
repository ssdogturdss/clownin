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

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKEN_KEY = 'clownin_expo_token';
const ACCOUNT_KEY = 'clownin_expo_account';
const EAS_GQL = 'https://api.expo.dev/graphql';

const STATUS_COLOR: Record<string, string> = {
  FINISHED: '#3fb950',
  IN_PROGRESS: '#58a6ff',
  ERRORED: '#f85149',
  CANCELED: '#6e7681',
  IN_QUEUE: '#d29922',
  NEW: '#d29922',
  UNKNOWN: '#6e7681',
};

const STATUS_LABEL: Record<string, string> = {
  FINISHED: 'Done',
  IN_PROGRESS: 'Building…',
  ERRORED: 'Failed',
  CANCELED: 'Canceled',
  IN_QUEUE: 'Queued',
  NEW: 'Queued',
  UNKNOWN: 'Unknown',
};

const PLATFORM_ICON: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  IOS: 'apple',
  ANDROID: 'android',
};

// ─── GQL helpers ──────────────────────────────────────────────────────────────

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
  if (!res.ok) throw new Error(`EAS API error ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

const VIEWER_QUERY = `
  query ClowninViewer {
    viewer {
      id
      username
      accounts {
        id
        name
      }
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
              app {
                name
                slug
              }
              artifacts {
                buildUrl
              }
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

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function EASBuildsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const s = makeStyles(colors);

  const [token, setToken] = useState('');
  const [inputToken, setInputToken] = useState('');
  const [account, setAccount] = useState('');
  const [username, setUsername] = useState('');

  const [builds, setBuilds] = useState<EASBuild[]>([]);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load saved token on mount ──────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const [savedToken, savedAccount] = await Promise.all([
        AsyncStorage.getItem(TOKEN_KEY),
        AsyncStorage.getItem(ACCOUNT_KEY),
      ]);
      if (savedToken && savedAccount) {
        setToken(savedToken);
        setAccount(savedAccount);
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
      }>(tok, BUILDS_QUERY, { accountName: acc, first: 30 });

      const list = (data.account?.byName?.builds?.edges ?? []).map((e) => e.node);
      setBuilds(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load builds');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // ── Auto-fetch when token+account are available ────────────────────────────

  useEffect(() => {
    if (!token || !account) return;
    fetchBuilds(token, account);
  }, [token, account, fetchBuilds]);

  // ── Poll while any build is active ────────────────────────────────────────

  useEffect(() => {
    const hasActive = builds.some(
      (b) => b.status === 'IN_PROGRESS' || b.status === 'IN_QUEUE' || b.status === 'NEW',
    );
    if (hasActive && token && account) {
      pollRef.current = setInterval(() => fetchBuilds(token, account, true), 15_000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [builds, token, account, fetchBuilds]);

  // ── Connect: validate token, persist ──────────────────────────────────────

  const handleConnect = useCallback(async () => {
    const tok = inputToken.trim();
    if (!tok) return;
    setConnecting(true);
    setError('');
    try {
      const data = await easQuery<{
        viewer: { id: string; username: string; accounts: { id: string; name: string }[] };
      }>(tok, VIEWER_QUERY);

      const acc = data.viewer?.accounts?.[0]?.name;
      const uname = data.viewer?.username;
      if (!acc) throw new Error('No Expo account found for this token');

      await AsyncStorage.setItem(TOKEN_KEY, tok);
      await AsyncStorage.setItem(ACCOUNT_KEY, acc);
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
    Alert.alert('Disconnect Expo', 'Remove your saved Expo token?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          await AsyncStorage.multiRemove([TOKEN_KEY, ACCOUNT_KEY]);
          setToken('');
          setAccount('');
          setUsername('');
          setBuilds([]);
          setInputToken('');
        },
      },
    ]);
  }, []);

  // ── Render build card ──────────────────────────────────────────────────────

  const renderBuild = useCallback(
    ({ item }: { item: EASBuild }) => {
      const statusColor = STATUS_COLOR[item.status] ?? STATUS_COLOR.UNKNOWN;
      const statusLabel = STATUS_LABEL[item.status] ?? item.status;
      const platformIcon = PLATFORM_ICON[item.platform] ?? 'help-circle-outline';
      const isActive = item.status === 'IN_PROGRESS' || item.status === 'IN_QUEUE' || item.status === 'NEW';
      const buildUrl = item.artifacts?.buildUrl;
      const date = new Date(item.createdAt);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

      return (
        <View style={[s.buildCard, { borderColor: isActive ? colors.info + '55' : colors.border }]}>
          {/* Left: platform icon */}
          <View style={[s.platformBadge, { backgroundColor: colors.secondary }]}>
            <MaterialCommunityIcons
              name={platformIcon}
              size={22}
              color={colors.foreground}
            />
          </View>

          {/* Middle: info */}
          <View style={s.buildInfo}>
            <Text style={[s.buildAppName, { color: colors.foreground }]} numberOfLines={1}>
              {item.app?.name ?? item.app?.slug ?? 'Unknown app'}
            </Text>
            <View style={s.buildMeta}>
              <Text style={[s.buildPlatform, { color: colors.mutedForeground }]}>
                {item.platform === 'IOS' ? 'iOS' : item.platform === 'ANDROID' ? 'Android' : item.platform}
              </Text>
              <Text style={[s.buildDot, { color: colors.mutedForeground }]}>·</Text>
              <Text style={[s.buildDate, { color: colors.mutedForeground }]}>
                {dateStr} {timeStr}
              </Text>
            </View>
            {/* Status row */}
            <View style={s.statusRow}>
              {isActive && (
                <ActivityIndicator size={10} color={statusColor} style={{ marginRight: 5 }} />
              )}
              {!isActive && (
                <View style={[s.statusDot, { backgroundColor: statusColor }]} />
              )}
              <Text style={[s.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
            </View>
          </View>

          {/* Right: download button */}
          {buildUrl ? (
            <Pressable
              style={[s.downloadBtn, { backgroundColor: colors.success + '22' }]}
              onPress={() => Linking.openURL(buildUrl)}
            >
              <MaterialCommunityIcons name="download" size={18} color={colors.success} />
            </Pressable>
          ) : (
            <View style={s.downloadPlaceholder} />
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
          <Pressable onPress={() => router.back()} hitSlop={12} style={s.backBtn}>
            <MaterialCommunityIcons name="arrow-left" size={22} color={colors.foreground} />
          </Pressable>
          <Text style={[s.navTitle, { color: colors.foreground }]}>EAS Builds</Text>
          <View style={{ width: 34 }} />
        </View>

        <ScrollView contentContainerStyle={s.connectBody} keyboardShouldPersistTaps="handled">
          <View style={[s.easLogo, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <MaterialCommunityIcons name="cellphone-arrow-down" size={40} color={colors.primary} />
          </View>
          <Text style={[s.connectTitle, { color: colors.foreground }]}>Connect Expo Account</Text>
          <Text style={[s.connectSubtitle, { color: colors.mutedForeground }]}>
            Paste an Expo access token to view your EAS build queue and download artifacts directly here.
          </Text>

          <Pressable
            style={s.getTokenLink}
            onPress={() => Linking.openURL('https://expo.dev/settings/access-tokens')}
          >
            <MaterialCommunityIcons name="open-in-new" size={13} color={colors.info} />
            <Text style={[s.getTokenText, { color: colors.info }]}>
              Get a token on expo.dev →
            </Text>
          </Pressable>

          <Text style={[s.inputLabel, { color: colors.mutedForeground }]}>EXPO ACCESS TOKEN</Text>
          <TextInput
            style={[s.tokenInput, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground }]}
            placeholder="expo_…"
            placeholderTextColor={colors.mutedForeground}
            value={inputToken}
            onChangeText={setInputToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={handleConnect}
            returnKeyType="done"
          />

          {error ? <Text style={[s.errorText, { color: colors.destructive }]}>{error}</Text> : null}

          <Pressable
            style={[s.connectBtn, { backgroundColor: colors.primary, opacity: connecting || !inputToken.trim() ? 0.55 : 1 }]}
            onPress={handleConnect}
            disabled={connecting || !inputToken.trim()}
          >
            {connecting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialCommunityIcons name="connection" size={18} color="#fff" />
            )}
            <Text style={s.connectBtnText}>{connecting ? 'Connecting…' : 'Connect'}</Text>
          </Pressable>

          <Text style={[s.privacyNote, { color: colors.mutedForeground }]}>
            Your token is stored locally on this device and only sent directly to Expo's API.
          </Text>
        </ScrollView>
      </View>
    );
  }

  // ── Builds screen ──────────────────────────────────────────────────────────

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Nav bar */}
      <View style={s.navBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={s.backBtn}>
          <MaterialCommunityIcons name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={s.navCenter}>
          <Text style={[s.navTitle, { color: colors.foreground }]}>EAS Builds</Text>
          {account ? (
            <Text style={[s.navAccount, { color: colors.mutedForeground }]}>{account}</Text>
          ) : null}
        </View>
        <Pressable onPress={handleDisconnect} hitSlop={12} style={s.disconnectBtn}>
          <MaterialCommunityIcons name="logout" size={19} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* Content */}
      {loading && builds.length === 0 ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[s.loadingText, { color: colors.mutedForeground }]}>Loading builds…</Text>
        </View>
      ) : error && builds.length === 0 ? (
        <View style={s.center}>
          <MaterialCommunityIcons name="alert-circle-outline" size={40} color={colors.destructive} />
          <Text style={[s.errorText, { color: colors.destructive, textAlign: 'center', marginTop: 12 }]}>{error}</Text>
          <Pressable
            style={[s.retryBtn, { backgroundColor: colors.primary }]}
            onPress={() => fetchBuilds(token, account)}
          >
            <Text style={s.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : builds.length === 0 ? (
        <View style={s.center}>
          <MaterialCommunityIcons name="package-variant-closed" size={48} color={colors.mutedForeground} />
          <Text style={[s.emptyTitle, { color: colors.foreground }]}>No builds yet</Text>
          <Text style={[s.emptySubtitle, { color: colors.mutedForeground }]}>
            Run {'"'}eas build{'"'} from your terminal to start a build.
          </Text>
          <Pressable
            style={s.docsLink}
            onPress={() => Linking.openURL('https://docs.expo.dev/build/introduction/')}
          >
            <MaterialCommunityIcons name="book-open-outline" size={14} color={colors.info} />
            <Text style={[s.docsLinkText, { color: colors.info }]}>EAS Build docs →</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={builds}
          keyExtractor={(b) => b.id}
          renderItem={renderBuild}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchBuilds(token, account);
              }}
              tintColor={colors.primary}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListHeaderComponent={
            error ? (
              <Text style={[s.errorBanner, { color: colors.warning, backgroundColor: colors.warning + '18', borderColor: colors.warning + '44' }]}>
                ⚠️ {error}
              </Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },

    navBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 10,
    },
    backBtn: { width: 34, alignItems: 'flex-start' },
    navCenter: { flex: 1, alignItems: 'center' },
    navTitle: { fontSize: 16, fontWeight: '700' },
    navAccount: { fontSize: 12, marginTop: 1 },
    disconnectBtn: { width: 34, alignItems: 'flex-end' },

    // Connect screen
    connectBody: { padding: 28, alignItems: 'center', paddingTop: 40 },
    easLogo: {
      width: 80, height: 80, borderRadius: 24, borderWidth: 1,
      alignItems: 'center', justifyContent: 'center', marginBottom: 22,
    },
    connectTitle: { fontSize: 22, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
    connectSubtitle: { fontSize: 14, lineHeight: 21, textAlign: 'center', marginBottom: 18 },
    getTokenLink: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 28 },
    getTokenText: { fontSize: 13, fontWeight: '600' },
    inputLabel: {
      alignSelf: 'flex-start', fontSize: 11, fontWeight: '700',
      letterSpacing: 0.6, marginBottom: 7,
    },
    tokenInput: {
      width: '100%', borderWidth: 1, borderRadius: 10,
      paddingHorizontal: 14, paddingVertical: 12,
      fontSize: 14, marginBottom: 6,
    },
    connectBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 8, borderRadius: 10, paddingVertical: 14,
      width: '100%', marginTop: 14,
    },
    connectBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
    privacyNote: { fontSize: 11, textAlign: 'center', lineHeight: 16, marginTop: 16 },

    // Builds list
    list: { padding: 14, paddingBottom: 40 },
    buildCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 12,
      borderWidth: 1, padding: 12,
    },
    platformBadge: {
      width: 42, height: 42, borderRadius: 11,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    buildInfo: { flex: 1, gap: 3 },
    buildAppName: { fontSize: 14, fontWeight: '700' },
    buildMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    buildPlatform: { fontSize: 12 },
    buildDot: { fontSize: 12 },
    buildDate: { fontSize: 12 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
    statusDot: { width: 7, height: 7, borderRadius: 4 },
    statusLabel: { fontSize: 12, fontWeight: '600' },
    downloadBtn: {
      width: 36, height: 36, borderRadius: 9,
      alignItems: 'center', justifyContent: 'center',
    },
    downloadPlaceholder: { width: 36 },

    // States
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
    loadingText: { fontSize: 14, marginTop: 10 },
    errorText: { fontSize: 13, lineHeight: 19 },
    errorBanner: {
      fontSize: 12, lineHeight: 18, borderRadius: 8,
      borderWidth: 1, padding: 10, marginBottom: 10,
    },
    retryBtn: { marginTop: 10, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 11 },
    retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 8 },
    emptySubtitle: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 4 },
    docsLink: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 14 },
    docsLinkText: { fontSize: 13, fontWeight: '600' },
  });
}
