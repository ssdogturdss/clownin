/**
 * EASBuildDetailModal
 *
 * Shows full build metadata + scrollable log output for a single EAS build.
 * Polls EAS every 5 s while the build is active (IN_PROGRESS / IN_QUEUE / NEW).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Modal,
  Linking,
  Platform,
  Animated,
  Share,
  ActionSheetIOS,
  Alert,
  AppState,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { resolveApiBaseUrl } from '@/app/_layout';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EASBuildSummary {
  id: string;
  status: string;
  platform: string;
  createdAt: string;
  appId?: string;
  app: { name: string; slug: string };
  artifacts?: { buildUrl?: string };
}

interface BuildDetail {
  id: string;
  status: string;
  platform: string;
  createdAt: string;
  updatedAt?: string;
  durationSeconds: number | null;
  buildUrl: string | null;
  logs: string[];
  /** Total log lines received so far — used as the offset for the next poll. */
  logOffset: number;
}

// ─── Maps (keep in sync with eas-builds.tsx) ─────────────────────────────────

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
  IN_PROGRESS: 'Building…',
  ERRORED:     'Failed',
  CANCELED:    'Canceled',
  IN_QUEUE:    'Queued',
  NEW:         'Queued',
};

const PLATFORM_ICON: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  IOS:     'apple',
  ANDROID: 'android',
};

const PLATFORM_LABEL: Record<string, string> = {
  IOS:     'iOS',
  ANDROID: 'Android',
};

const PLATFORM_COLOR: Record<string, string> = {
  IOS:     '#a8b2bf',
  ANDROID: '#3ddc84',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function isActive(status: string): boolean {
  return status === 'IN_PROGRESS' || status === 'IN_QUEUE' || status === 'NEW';
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  build: EASBuildSummary | null;
  authToken: string;
  onClose: () => void;
}

export function EASBuildDetailModal({ build, authToken, onClose }: Props) {
  const colors  = useColors();
  const insets  = useSafeAreaInsets();
  const s       = makeStyles(colors);

  const [detail,      setDetail]      = useState<BuildDetail | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  /** Non-empty when a poll tick fails but we already have log lines to show. */
  const [pollError,   setPollError]   = useState('');
  const [logCount,    setLogCount]    = useState(0);
  const [toastText,   setToastText]   = useState('');
  const [pollingPaused, setPollingPaused] = useState(
    AppState.currentState !== 'active',
  );
  /** True after 3 consecutive poll failures — interval stopped, manual retry shown. */
  const [pollStopped, setPollStopped] = useState(false);
  /** True while the slow reconnect probe is running after polling stopped. */
  const [reconnectProbing, setReconnectProbing] = useState(false);

  const scrollRef    = useRef<ScrollView>(null);
  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when the user has manually scrolled up; suppresses auto-scroll to bottom.
  const userScrolled  = useRef(false);
  // Accumulated log lines across poll ticks — avoids replacing the whole array.
  const accLogsRef    = useRef<string[]>([]);
  // Absolute offset into the full server log stream (= total lines received so far).
  const logOffsetRef  = useRef(0);
  // AbortController for the in-flight fetch — cancelled when the build changes.
  const abortRef      = useRef<AbortController | null>(null);
  // Tracks current AppState so every interval-start path can guard against
  // restarting the poll while the app is backgrounded/inactive.
  const appStateRef   = useRef(AppState.currentState);
  // Consecutive poll-failure counter — stops the interval at 3.
  const pollFailCountRef = useRef(0);
  // Ref mirror of pollStopped so event-handler closures can read it synchronously
  // without depending on stale React state.
  const pollStoppedRef = useRef(false);
  // Slow reconnect probe (30 s) that fires automatically after polling stops so
  // the user doesn't have to tap Retry after a transient network outage.
  const reconnectProbeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set to true for the duration of a probe fetch so fetchLogs skips its
  // normal failure-counter and error-banner logic on probe misses.
  const isReconnectProbeRef = useRef(false);

  // ── Fetch logs ──────────────────────────────────────────────────────────────

  const fetchLogs = useCallback(async (silent = false) => {
    if (!build) return;

    // Cancel any previous in-flight request before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!silent) setLoading(true);

    try {
      const base = resolveApiBaseUrl();
      // On poll ticks (silent=true) ask the server for only new lines since
      // our last fetch; on the first load (silent=false) always start from 0.
      const offset = silent ? logOffsetRef.current : 0;
      const url = `${base}/api/eas/builds/${build.id}/logs${offset > 0 ? `?offset=${offset}` : ''}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: controller.signal,
      });
      const json = await res.json() as BuildDetail & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `Server error ${res.status}`);

      // Build the accumulated log array:
      //   - First load (offset === 0): replace entirely.
      //   - Poll tick: append only the new delta lines.
      const newLines = json.logs ?? [];
      const merged = offset === 0
        ? newLines
        : [...accLogsRef.current, ...newLines];

      accLogsRef.current  = merged;
      logOffsetRef.current = json.logOffset ?? merged.length;

      // Merge new metadata into detail but swap in the accumulated log array.
      setDetail({ ...json, logs: merged });
      setLogCount(merged.length);

      // Connection restored — clear any inline retry banner and reset failure counter.
      pollFailCountRef.current = 0;
      pollStoppedRef.current   = false;
      setPollStopped(false);
      setError('');
      setPollError('');

      // Auto-scroll to bottom only when the user hasn't manually scrolled up.
      if (!userScrolled.current && isActive(json.status) && newLines.length > 0) {
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
      }

      // ── Background-resume log-gap recovery ──────────────────────────────
      // If the build finished while the app was backgrounded AND the server
      // truncated or rotated its log buffer, the offset-based catch-up fetch
      // returns 0 new lines even though lines were missed.  Detect this by
      // checking whether the build is now terminal and the server's logOffset
      // did not advance past the offset we requested with.  In that case,
      // silently re-fetch from offset 0 so no lines are lost.
      const terminalStatus = !isActive(json.status);
      const noNewLines = (json.logOffset ?? merged.length) <= offset;
      if (silent && offset > 0 && terminalStatus && noNewLines) {
        // Reset accumulated state so the full-load response replaces everything.
        logOffsetRef.current = 0;
        accLogsRef.current   = [];
        fetchLogs(true);
      }
    } catch (err) {
      // Ignore aborted requests — they are intentional cancellations.
      if (err instanceof Error && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'Failed to load logs';
      // All poll-tick (silent) failures count toward the consecutive-failure
      // limit, unless this fetch was fired by the reconnect probe — probe
      // failures are swallowed silently so they don't flip error UI or
      // double-count against the threshold.
      if (silent) {
        if (!isReconnectProbeRef.current) {
          pollFailCountRef.current += 1;
          // After 3 consecutive failures, stop hammering the server and ask the
          // user to retry manually (or wait for the reconnect probe to succeed).
          if (pollFailCountRef.current >= 3) {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            pollStoppedRef.current = true;
            setPollStopped(true);
          }
          // Show inline banner if we have logs; otherwise surface a full-screen
          // error so the user knows no data has been loaded yet.
          if (accLogsRef.current.length > 0) {
            setPollError(msg);
          } else {
            setError(msg);
          }
        }
        // Probe failures are intentionally silent — the probe interval keeps
        // running and tries again after 30 s.
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [build, authToken]);

  // ── Mount / build change ────────────────────────────────────────────────────

  useEffect(() => {
    if (!build) {
      // Abort any in-flight request for the previous build.
      abortRef.current?.abort();
      setDetail(null);
      setError('');
      setLoading(false);
      return;
    }
    // Abort the previous build's in-flight request immediately so its response
    // cannot overwrite the reset state below.
    abortRef.current?.abort();
    // Reset all accumulated state for the new build synchronously so that a
    // fetch failure for the new build triggers the full-screen error rather
    // than rendering stale logs from the previous build.
    setDetail(null);
    setError('');
    setPollError('');
    pollStoppedRef.current   = false;
    setPollStopped(false);
    pollFailCountRef.current = 0;
    userScrolled.current  = false;
    accLogsRef.current    = [];
    logOffsetRef.current  = 0;
    fetchLogs(false);
  }, [build, fetchLogs]);

  // ── Polling for active builds ───────────────────────────────────────────────
  // Only start the interval when the app is in the foreground.  The AppState
  // listener is responsible for pausing/resuming, so if we're currently
  // backgrounded we skip creating a new interval here — it will be created
  // once the app returns to "active".

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (!build) return;
    const status = detail?.status ?? build.status;
    // Don't start a new interval if the user must manually retry after failures.
    if (isActive(status) && appStateRef.current === 'active' && !pollStoppedRef.current) {
      pollRef.current = setInterval(() => fetchLogs(true), 5_000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [build, detail?.status, fetchLogs, pollStopped]);

  // ── Reconnect probe: auto-restart polling after network recovers ────────────
  // When polling is stopped due to consecutive failures, a slow 30-second probe
  // silently retries in the background.  On the first successful response the
  // normal fetchLogs success path resets pollStopped, which causes this effect
  // to clean up the probe and the polling effect to restart the 5-second interval.

  useEffect(() => {
    if (reconnectProbeRef.current) {
      clearInterval(reconnectProbeRef.current);
      reconnectProbeRef.current = null;
    }
    const currentStatus = detail?.status ?? build?.status ?? '';
    if (pollStopped && build && isActive(currentStatus) && appStateRef.current === 'active') {
      setReconnectProbing(true);
      reconnectProbeRef.current = setInterval(async () => {
        isReconnectProbeRef.current = true;
        try { await fetchLogs(true); } finally { isReconnectProbeRef.current = false; }
      }, 30_000);
    } else {
      setReconnectProbing(false);
    }
    return () => {
      if (reconnectProbeRef.current) {
        clearInterval(reconnectProbeRef.current);
        reconnectProbeRef.current = null;
      }
      isReconnectProbeRef.current = false;
    };
  }, [pollStopped, build, detail?.status, fetchLogs]);

  // ── Manual retry after polling stopped ─────────────────────────────────────

  const handlePollRetry = useCallback(() => {
    pollFailCountRef.current = 0;
    pollStoppedRef.current   = false;
    setPollStopped(false);
    setPollError('');
    setError('');
    // Immediate catch-up fetch.  Use silent=false if we have no logs yet so the
    // loading spinner shows; silent=true if we already have lines to display.
    fetchLogs(accLogsRef.current.length === 0 ? false : true);
    // Only restart the interval when the build is still active and the app is
    // in the foreground.
    const currentStatus = detail?.status ?? build?.status ?? '';
    if (isActive(currentStatus) && appStateRef.current === 'active') {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => fetchLogs(true), 5_000);
    }
  }, [fetchLogs, detail?.status, build?.status]);

  // ── Stop polling / reset on close ──────────────────────────────────────────

  const handleClose = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (reconnectProbeRef.current) clearInterval(reconnectProbeRef.current);
    reconnectProbeRef.current = null;
    isReconnectProbeRef.current = false;
    // Clean up toast so no delayed setState fires after close
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastOpacity.stopAnimation();
    onClose();
  };

  // ── AppState: pause polling while backgrounded, resume on foregrounding ────
  // appStateRef is kept in sync here so the polling effect (and any other
  // interval-start path) can check it synchronously without a stale closure.

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'background' || nextState === 'inactive') {
        // Pause: clear the interval, the reconnect probe, and any in-flight
        // request so no network traffic fires while the app is invisible.
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        if (reconnectProbeRef.current) {
          clearInterval(reconnectProbeRef.current);
          reconnectProbeRef.current = null;
        }
        isReconnectProbeRef.current = false;
        setReconnectProbing(false);
        abortRef.current?.abort();
        setPollingPaused(true);
      } else if (nextState === 'active' && prevState !== 'active') {
        // Resume: only when we're actually transitioning back to foreground.
        // Always clear first to prevent duplicates, then restart appropriately.
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        const currentStatus = detail?.status ?? build?.status ?? '';
        if (build && isActive(currentStatus)) {
          if (!pollStoppedRef.current) {
            // Normal resume: immediate catch-up fetch then 5-second cadence.
            fetchLogs(true);
            pollRef.current = setInterval(() => fetchLogs(true), 5_000);
          } else {
            // Polling was stopped due to failures; restart the reconnect probe
            // (it was cleared when we went to background).
            if (reconnectProbeRef.current) clearInterval(reconnectProbeRef.current);
            setReconnectProbing(true);
            reconnectProbeRef.current = setInterval(async () => {
              isReconnectProbeRef.current = true;
              try { await fetchLogs(true); } finally { isReconnectProbeRef.current = false; }
            }, 30_000);
          }
        }
        setPollingPaused(false);
      }
    });
    return () => subscription.remove();
  }, [build, detail?.status, fetchLogs]);

  // ── Unmount cleanup ────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (reconnectProbeRef.current) clearInterval(reconnectProbeRef.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastOpacity.stopAnimation();
      abortRef.current?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Share build (link + optional log tail for failures) ────────────────────

  const handleShare = useCallback(async () => {
    if (!build) return;
    const easUrl = `https://expo.dev/builds/${build.id}`;
    const liveStatus  = detail?.status ?? build.status;
    const statusLbl   = STATUS_LABEL[liveStatus]    ?? liveStatus;
    const platLbl     = PLATFORM_LABEL[build.platform] ?? build.platform;
    const appName     = build.app.name || build.app.slug;
    const currentLogs = accLogsRef.current;

    // For failed builds, append the last 30 error lines so the recipient
    // can see the problem without opening the link on another device.
    const isFailure = liveStatus === 'ERRORED';
    const logTail   = isFailure && currentLogs.length > 0
      ? '\n\nLog tail:\n' + currentLogs.slice(-30).join('\n')
      : '';

    const message = `EAS Build ${statusLbl} — ${appName} (${platLbl})\n${easUrl}${logTail}`;

    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { url: easUrl, message }
          : { message, title: `EAS Build — ${appName}` },
      );
    } catch {
      // User cancelled or share sheet dismissed — nothing to do.
    }
  }, [build, detail]);

  // ── Copy a log line to clipboard with a brief toast ─────────────────────────

  const copyLine = useCallback((line: string) => {
    Clipboard.setStringAsync(line);
    setToastText('Copied!');
    // Cancel any in-flight animation and pending hide timer before restarting
    toastOpacity.stopAnimation();
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastOpacity.setValue(0);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 120, useNativeDriver: true }),
      Animated.delay(1200),
      Animated.timing(toastOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start();
    toastTimer.current = setTimeout(() => setToastText(''), 1700);
  }, [toastOpacity]);

  // ── Share a single log line via the native share sheet ─────────────────────

  const shareLine = useCallback(async (line: string) => {
    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { message: line }
          : { message: line, title: 'Build Log' },
      );
    } catch {
      // User cancelled or share sheet dismissed — nothing to do.
    }
  }, []);

  // ── Long-press context menu: Copy or Share ──────────────────────────────────

  const showLineMenu = useCallback((line: string) => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Copy', 'Share'], cancelButtonIndex: 0 },
        (buttonIndex) => {
          if (buttonIndex === 1) copyLine(line);
          else if (buttonIndex === 2) shareLine(line);
        },
      );
    } else {
      const preview = line.trim().slice(0, 80) + (line.length > 80 ? '…' : '');
      Alert.alert('', preview, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Copy',  onPress: () => copyLine(line) },
        { text: 'Share', onPress: () => shareLine(line) },
      ]);
    }
  }, [copyLine, shareLine]);

  // ── Nothing to show ────────────────────────────────────────────────────────

  if (!build) return null;

  const liveStatus   = detail?.status ?? build.status;
  const statusColor  = STATUS_COLOR[liveStatus]    ?? '#6e7681';
  const statusLabel  = STATUS_LABEL[liveStatus]    ?? liveStatus;
  const platIcon     = PLATFORM_ICON[build.platform] ?? 'help-circle-outline';
  const platLabel    = PLATFORM_LABEL[build.platform] ?? build.platform;
  const platColor    = PLATFORM_COLOR[build.platform] ?? colors.mutedForeground;
  const active       = isActive(liveStatus);
  const downloadUrl  = detail?.buildUrl ?? build.artifacts?.buildUrl;
  const logs         = detail?.logs ?? [];

  return (
    <Modal
      visible={!!build}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={[s.root, { paddingTop: Platform.OS === 'ios' ? insets.top + 8 : 16 }]}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <View style={s.header}>
          <Pressable onPress={handleClose} hitSlop={12} style={s.closeBtn}>
            <MaterialCommunityIcons name="close" size={20} color={colors.foreground} />
          </Pressable>
          <Text style={[s.title, { color: colors.foreground }]} numberOfLines={1}>
            Build Logs
          </Text>
          <View style={s.headerActions}>
            {downloadUrl && (
              <Pressable
                style={[s.headerBtn, { backgroundColor: colors.success + '1a' }]}
                onPress={() => Linking.openURL(downloadUrl)}
                hitSlop={8}
              >
                <MaterialCommunityIcons name="download-outline" size={20} color={colors.success} />
              </Pressable>
            )}
            <Pressable
              style={[s.headerBtn, { backgroundColor: colors.secondary }]}
              onPress={handleShare}
              hitSlop={8}
            >
              <MaterialCommunityIcons name="share-variant-outline" size={20} color={colors.foreground} />
            </Pressable>
          </View>
        </View>

        {/* ── Metadata strip ─────────────────────────────────────────────── */}
        <View style={[s.meta, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <View style={[s.platBadge, { backgroundColor: platColor + '18' }]}>
            <MaterialCommunityIcons name={platIcon} size={20} color={platColor} />
          </View>

          <View style={s.metaInfo}>
            <Text style={[s.metaAppName, { color: colors.foreground }]} numberOfLines={1}>
              {build.app.name || build.app.slug}
            </Text>
            <Text style={[s.metaLine, { color: colors.mutedForeground }]}>
              {platLabel} · Started {formatDate(build.createdAt)}
              {detail?.durationSeconds != null
                ? `  ·  ${formatDuration(detail.durationSeconds)}`
                : ''}
            </Text>
          </View>

          <View style={[s.statusPill, { backgroundColor: statusColor + '1a' }]}>
            {active
              ? <ActivityIndicator size={9} color={statusColor} style={{ marginRight: 4 }} />
              : <View style={[s.statusDot, { backgroundColor: statusColor }]} />
            }
            <Text style={[s.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>

        {/* ── Log area ───────────────────────────────────────────────────── */}
        {loading && !detail ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[s.loadingText, { color: colors.mutedForeground }]}>Loading logs…</Text>
          </View>
        ) : error && !detail ? (
          // Full-screen error only when the initial load failed and there are
          // no accumulated log lines to show.
          <View style={s.center}>
            <MaterialCommunityIcons name="alert-circle-outline" size={32} color={colors.destructive} />
            <Text style={[s.errorText, { color: colors.mutedForeground }]}>{error}</Text>
            <Pressable style={[s.retryBtn, { backgroundColor: colors.primary }]} onPress={() => fetchLogs(false)}>
              <MaterialCommunityIcons name="refresh" size={14} color="#fff" />
              <Text style={s.retryBtnText}>Retry</Text>
            </Pressable>
          </View>
        ) : logs.length === 0 ? (
          // No log lines yet — either still waiting or polling was stopped after
          // three consecutive failures while the build was still starting up.
          <View style={s.center}>
            <MaterialCommunityIcons
              name={pollStopped ? 'wifi-off' : (active ? 'timer-sand' : 'text-box-remove-outline')}
              size={32}
              color={pollStopped ? colors.destructive : colors.mutedForeground}
            />
            <Text style={[s.emptyText, { color: pollStopped ? colors.destructive : colors.mutedForeground }]}>
              {pollStopped
                ? 'Lost connection — no logs received'
                : active
                  ? 'Waiting for log output…'
                  : 'No logs available for this build.'}
            </Text>
            {pollStopped && (
              <Pressable
                style={[s.retryBtn, { backgroundColor: colors.primary }]}
                onPress={handlePollRetry}
              >
                <MaterialCommunityIcons name="refresh" size={14} color="#fff" />
                <Text style={s.retryBtnText}>Retry</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <>
            {/* ── Inline retry banner (poll failure, logs already visible) ── */}
            {!!pollError && (
              <View style={[s.retryBanner, { backgroundColor: colors.destructive + '18', borderColor: colors.destructive + '44' }]}>
                <MaterialCommunityIcons name="wifi-off" size={14} color={colors.destructive} />
                {pollStopped ? (
                  <>
                    <Text style={[s.retryBannerText, { color: colors.destructive }]} numberOfLines={1}>
                      Connection lost
                    </Text>
                    <Pressable
                      onPress={handlePollRetry}
                      hitSlop={10}
                      style={[s.retryBannerBtn, { backgroundColor: colors.destructive }]}
                    >
                      <MaterialCommunityIcons name="refresh" size={12} color="#fff" />
                      <Text style={s.retryBannerBtnText}>Retry</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Text style={[s.retryBannerText, { color: colors.destructive }]} numberOfLines={1}>
                      Lost connection — retrying…
                    </Text>
                    <Pressable
                      onPress={() => setPollError('')}
                      hitSlop={10}
                      style={s.retryBannerDismiss}
                    >
                      <MaterialCommunityIcons name="close" size={14} color={colors.destructive} />
                    </Pressable>
                  </>
                )}
              </View>
            )}

            <ScrollView
              ref={scrollRef}
              style={[s.logScroll, { backgroundColor: colors.background }]}
              contentContainerStyle={s.logContent}
              // Mark the user as having scrolled up the moment they drag.
              onScrollBeginDrag={() => { userScrolled.current = true; }}
              // When the scroll position settles near the bottom (within 40 px),
              // re-enable auto-scroll so the next poll resumes tailing.
              onScroll={({ nativeEvent: e }) => {
                const distanceFromBottom =
                  e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y;
                if (distanceFromBottom < 40) {
                  userScrolled.current = false;
                }
              }}
              scrollEventThrottle={100}
            >
              {logs.map((line, i) => (
                <Pressable
                  key={i}
                  onPress={() => copyLine(line)}
                  onLongPress={() => showLineMenu(line)}
                  delayLongPress={300}
                  android_ripple={{ color: colors.primary + '22', borderless: false }}
                >
                  <Text
                    style={[s.logLine, { color: lineColor(line, colors) }]}
                    selectable
                  >
                    {line}
                  </Text>
                </Pressable>
              ))}
              {/* Tail padding so the last line isn't flush at the bottom */}
              <View style={{ height: insets.bottom + 24 }} />
            </ScrollView>

            {/* ── Copy toast ──────────────────────────────────────────────── */}
            <Animated.View
              pointerEvents="none"
              style={[s.toast, { opacity: toastOpacity, backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[s.toastText, { color: colors.foreground }]}>{toastText}</Text>
            </Animated.View>
          </>
        )}

        {/* ── Polling indicator ──────────────────────────────────────────── */}
        {active && !!detail && (
          <View style={[s.pollingBar, { borderTopColor: colors.border }]}>
            {pollingPaused ? (
              <MaterialCommunityIcons name="pause-circle-outline" size={11} color={colors.mutedForeground} />
            ) : pollStopped ? (
              <MaterialCommunityIcons name="autorenew" size={11} color={colors.mutedForeground} />
            ) : (
              <ActivityIndicator size={11} color={colors.primary} />
            )}
            <Text style={[s.pollingText, { color: colors.mutedForeground }]}>
              {pollingPaused
                ? 'Paused'
                : pollStopped
                  ? reconnectProbing ? 'Reconnecting…' : 'Connection lost'
                  : `Live · ${logCount} ${logCount === 1 ? 'line' : 'lines'}`}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ─── Log line colouring ───────────────────────────────────────────────────────

function lineColor(line: string, colors: ReturnType<typeof useColors>): string {
  const l = line.toLowerCase();
  if (/\b(error|failed|failure|fatal)\b/.test(l))  return colors.destructive;
  if (/\b(warn|warning|deprecated)\b/.test(l))       return '#d29922';
  if (/\b(success|succeeded|✓|✔)\b/.test(l))        return colors.success;
  return colors.foreground;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    closeBtn: {
      width: 36, height: 36, borderRadius: 10,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.secondary,
    },
    title: {
      flex: 1, textAlign: 'center',
      fontSize: 15, fontWeight: '700', letterSpacing: 0.1,
    },
    headerActions: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
    },
    headerBtn: {
      width: 36, height: 36, borderRadius: 10,
      alignItems: 'center', justifyContent: 'center',
    },

    meta: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      marginHorizontal: 12, marginTop: 10, marginBottom: 6,
      borderRadius: 12, borderWidth: 1, padding: 12,
    },
    platBadge: {
      width: 38, height: 38, borderRadius: 10,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    metaInfo: { flex: 1 },
    metaAppName: { fontSize: 14, fontWeight: '700' },
    metaLine:    { fontSize: 11, marginTop: 2, lineHeight: 16 },
    statusPill: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20, flexShrink: 0,
    },
    statusDot:  { width: 6, height: 6, borderRadius: 3 },
    statusText: { fontSize: 11, fontWeight: '700' },

    logScroll:   { flex: 1 },
    logContent:  { paddingHorizontal: 12, paddingTop: 8 },
    logLine: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 11, lineHeight: 17,
    },

    center:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
    loadingText: { fontSize: 13, marginTop: 6 },
    errorText:   { fontSize: 13, textAlign: 'center', lineHeight: 20 },
    emptyText:   { fontSize: 13, textAlign: 'center', lineHeight: 20 },
    retryBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10, marginTop: 4,
    },
    retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

    retryBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      marginHorizontal: 12, marginTop: 4, marginBottom: 2,
      paddingHorizontal: 10, paddingVertical: 7,
      borderRadius: 8, borderWidth: 1,
    },
    retryBannerText: { flex: 1, fontSize: 12, fontWeight: '600' },
    retryBannerDismiss: { padding: 2 },
    retryBannerBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4,
    },
    retryBannerBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },

    pollingBar: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 16, paddingVertical: 8,
      borderTopWidth: 1,
    },
    pollingText: { fontSize: 11 },

    toast: {
      position: 'absolute',
      alignSelf: 'center',
      bottom: 60,
      paddingHorizontal: 18,
      paddingVertical: 9,
      borderRadius: 20,
      borderWidth: 1,
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 6,
    },
    toastText: { fontSize: 13, fontWeight: '600' },
  });
}
