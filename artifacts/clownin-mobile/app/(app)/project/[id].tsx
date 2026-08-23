import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  Animated,
  Platform,
  PanResponder,
  KeyboardAvoidingView,
  Keyboard,
  Linking,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { SyntaxHighlighter, CODE_LINE_HEIGHT } from '@/components/SyntaxHighlighter';
import { AgentChat } from '@/components/AgentChat';
import { GitHubExportModal } from '@/components/GitHubExportModal';
import { DeployModal } from '@/components/DeployModal';
import { InAppPreview } from '@/components/InAppPreview';
import { ServePreview } from '@/components/ServePreview';
import { SharePreviewModal } from '@/components/SharePreviewModal';
import { router, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useGetProject,
  useCreateFile,
  useUpdateFile,
  useDeleteFile,
  useUpdateProject,
  useListServers,
  getGetProjectQueryKey,
} from '@workspace/api-client-react';
import type { ProjectFile } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { apiUrl } from '@/lib/apiUrl';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { fetch as expoFetch } from 'expo/fetch';

// ─── Terminal types ───────────────────────────────────────────────────────────
type TerminalLine = { id: string; type: 'stdout' | 'stderr' | 'system' | 'input'; text: string };

// ─── Language icon helper ─────────────────────────────────────────────────────
function langIcon(language: string) {
  if (language === 'python') return 'language-python';
  if (language === 'typescript') return 'language-typescript';
  if (language === 'bash') return 'bash';
  if (language === 'go') return 'language-go';
  if (language === 'rust') return 'language-rust';
  if (language === 'ruby') return 'language-ruby';
  if (language === 'java') return 'language-java';
  return 'language-javascript';
}

// ─── File-tree item ───────────────────────────────────────────────────────────
function FileItem({
  file,
  selected,
  onSelect,
  onLongPress,
  onDelete,
  colors,
}: {
  file: ProjectFile;
  selected: boolean;
  onSelect: () => void;
  onLongPress: () => void;
  onDelete: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[fileStyles.item, selected && { backgroundColor: colors.primary + '22' }]}>
      <Pressable
        style={fileStyles.itemMain}
        onPress={onSelect}
        onLongPress={onLongPress}
      >
        <MaterialCommunityIcons
          name={langIcon(file.language) as React.ComponentProps<typeof MaterialCommunityIcons>['name']}
          size={14}
          color={selected ? colors.primary : colors.mutedForeground}
          style={{ marginRight: 6 }}
        />
        <Text
          style={[
            fileStyles.name,
            { color: selected ? colors.primary : colors.foreground },
          ]}
          numberOfLines={1}
        >
          {file.path}
        </Text>
      </Pressable>
      <Pressable
        onPress={(e) => { (e as any).stopPropagation?.(); onDelete(); }}
        hitSlop={8}
        style={fileStyles.deleteBtn}
      >
        <Ionicons name="trash-outline" size={12} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

const fileStyles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', borderRadius: 6 },
  itemMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  name: { flex: 1, fontSize: 12, fontFamily: 'Inter_400Regular' },
  deleteBtn: { padding: 6 },
});

// ─── Split ratio snaps ────────────────────────────────────────────────────────
const RATIO_SNAPS = [0.3, 0.5, 0.7];

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function ProjectEditorScreen() {
  const { id, initialMessage } = useLocalSearchParams<{ id: string; initialMessage?: string }>();
  const projectId = Number(id);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  const { data: project, isLoading } = useGetProject(projectId);
  const { data: servers = [] } = useListServers();
  const updateProjectMutation = useUpdateProject();

  // Whether this project has a dependency manifest that triggers auto-install.
  // Used to show/hide the "Clean install" long-press option on the Run button.
  const hasDepFiles = (project?.files ?? []).some(
    (f) => f.path === 'package.json' || f.path === 'requirements.txt',
  );

  const handlePickServer = useCallback(() => {
    const activeServer = servers.find((s) => s.id === project?.serverId);
    const options = [
      { text: 'Local (default)', onPress: () => updateProjectMutation.mutateAsync({ id: projectId, data: { serverId: null } }).then(() => queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) })).catch(() => {}) },
      ...servers.map((s) => ({
        text: `${s.name} (${s.username}@${s.host})${project?.serverId === s.id ? ' ✓' : ''}`,
        onPress: () => updateProjectMutation.mutateAsync({ id: projectId, data: { serverId: s.id } }).then(() => queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) })).catch(() => {}),
      })),
      { text: 'Manage servers', onPress: () => router.push('/(app)/servers') },
      { text: 'Cancel', style: 'cancel' as const, onPress: () => {} },
    ];
    Alert.alert(
      'Run on server',
      activeServer ? `Currently: ${activeServer.name}` : 'Currently: Local',
      options,
    );
  }, [servers, project, projectId, updateProjectMutation, queryClient]);

  // ── Split-screen state ────────────────────────────────────────────────────
  const DEFAULT_SPLIT_RATIO = 0.45;
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO);
  const splitRatioRef = useRef(DEFAULT_SPLIT_RATIO);
  const gestureStartRatioRef = useRef(DEFAULT_SPLIT_RATIO);

  // Actual measured size of the split container (excludes header).
  // Stored in state so that layout and rotation changes trigger a re-render.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerSizeRef = useRef({ width: 0, height: 0 });
  // Used only for orientation detection inside PanResponder (can't read state there)
  const screenDimsRef = useRef({ width, height });
  useEffect(() => { screenDimsRef.current = { width, height }; }, [width, height]);

  const onSplitContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    // Only set state when dimensions actually change to avoid spurious re-renders
    if (w !== containerSizeRef.current.width || h !== containerSizeRef.current.height) {
      containerSizeRef.current = { width: w, height: h };
      setContainerSize({ width: w, height: h });
    }
  }, []);

  // Reset ratio to default immediately on projectId change, then load the persisted value
  useEffect(() => {
    setSplitRatio(DEFAULT_SPLIT_RATIO);
    splitRatioRef.current = DEFAULT_SPLIT_RATIO;
    let cancelled = false;
    AsyncStorage.getItem(`split_ratio_${projectId}`)
      .then((saved) => {
        if (cancelled || saved === null) return;
        const parsed = parseFloat(saved);
        if (isFinite(parsed) && parsed >= 0.2 && parsed <= 0.8) {
          setSplitRatio(parsed);
          splitRatioRef.current = parsed;
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  // Stable save callback ref
  const saveRatioRef = useRef<((r: number) => void) | null>(null);
  useEffect(() => {
    saveRatioRef.current = (r: number) =>
      AsyncStorage.setItem(`split_ratio_${projectId}`, String(r)).catch(() => {});
  }, [projectId]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        gestureStartRatioRef.current = splitRatioRef.current;
      },
      onPanResponderMove: (_, gs) => {
        // Use measured container size so ratios are relative to the actual panel space
        const { width: cw, height: ch } = containerSizeRef.current;
        const landscape = screenDimsRef.current.width > screenDimsRef.current.height;
        const total = landscape ? cw : ch;
        if (total <= 0) return;
        const delta = landscape ? gs.dx : gs.dy;
        const newRatio = Math.max(0.2, Math.min(0.8, gestureStartRatioRef.current + delta / total));
        splitRatioRef.current = newRatio;
        setSplitRatio(newRatio);
      },
      onPanResponderRelease: () => {
        const current = splitRatioRef.current;
        const nearest = RATIO_SNAPS.reduce((a, b) =>
          Math.abs(b - current) < Math.abs(a - current) ? b : a
        );
        splitRatioRef.current = nearest;
        setSplitRatio(nearest);
        saveRatioRef.current?.(nearest);
      },
    })
  ).current;

  // Chat panel size — derived from containerSize state so rotation and initial layout
  // always trigger a re-render with the correct measured dimensions.
  // Falls back to screen size (portrait) or screen width (landscape) before the first layout event.
  const containerMain = isLandscape
    ? (containerSize.width  || width)
    : (containerSize.height || height);
  const chatSize = Math.round(containerMain * splitRatio);

  // ── Editor state ──────────────────────────────────────────────────────────
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const selectedFileIdRef = useRef<number | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const codeInputRef = useRef<TextInput>(null);
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const pendingScrollLineRef = useRef<number | null>(null);
  const sharedScrollY = useRef(0);
  const viewScrollRef = useRef<ScrollView>(null);
  const pendingScrollSaveRef = useRef<{ fileId: number; y: number } | null>(null);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorLineRef = useRef(0);

  const flushScrollSave = useCallback(() => {
    if (scrollSaveTimer.current) {
      clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = null;
    }
    const pending = pendingScrollSaveRef.current;
    if (!pending) return;
    pendingScrollSaveRef.current = null;
    AsyncStorage.setItem(`scroll_${projectId}_${pending.fileId}`, String(pending.y)).catch(() => {});
  }, [projectId]);

  const saveScrollOffset = useCallback((fileId: number, y: number) => {
    pendingScrollSaveRef.current = { fileId, y };
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = setTimeout(() => {
      const pending = pendingScrollSaveRef.current;
      if (!pending) return;
      pendingScrollSaveRef.current = null;
      scrollSaveTimer.current = null;
      AsyncStorage.setItem(`scroll_${projectId}_${pending.fileId}`, String(pending.y)).catch(() => {});
    }, 300);
  }, [projectId]);

  useEffect(() => {
    if (!isEditing) return;
    const LINE_HEIGHT = CODE_LINE_HEIGHT;
    const TOP_PADDING = 14;
    let targetY: number;
    if (pendingScrollLineRef.current !== null) {
      targetY = Math.max(0, pendingScrollLineRef.current * LINE_HEIGHT + TOP_PADDING - LINE_HEIGHT * 2);
      pendingScrollLineRef.current = null;
    } else {
      targetY = sharedScrollY.current;
    }
    if (targetY <= 0) return;
    const timerId = setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (codeInputRef.current as any)?.setNativeProps?.({ contentOffset: { x: 0, y: targetY } });
    }, 100);
    return () => clearTimeout(timerId);
  }, [isEditing]);

  useEffect(() => { selectedFileIdRef.current = selectedFileId; }, [selectedFileId]);

  useEffect(() => {
    if (!isEditing) return;
    const LINE_HEIGHT = CODE_LINE_HEIGHT;
    const TOP_PADDING = 14;
    const scrollTo = (y: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (codeInputRef.current as any)?.setNativeProps?.({ contentOffset: { x: 0, y } });
      sharedScrollY.current = y;
      const fileId = selectedFileIdRef.current;
      if (fileId !== null) saveScrollOffset(fileId, y);
    };
    const onKeyboardShow = () => {
      const line = cursorLineRef.current;
      const targetY = Math.max(0, line * LINE_HEIGHT + TOP_PADDING - LINE_HEIGHT * 2);
      setTimeout(() => scrollTo(targetY), 150);
    };
    const onKeyboardHide = () => {
      const y = sharedScrollY.current;
      setTimeout(() => scrollTo(y), 50);
    };
    const subShow = Keyboard.addListener('keyboardDidShow', onKeyboardShow);
    const subHide = Keyboard.addListener('keyboardDidHide', onKeyboardHide);
    return () => { subShow.remove(); subHide.remove(); };
  }, [isEditing, saveScrollOffset]);

  const pendingContentRef = useRef<string | null>(null);
  const pendingFileIdRef = useRef<number | null>(null);

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarAnim = useRef(new Animated.Value(1)).current;

  // ── Auto-run ──────────────────────────────────────────────────────────────
  const [autoRun, setAutoRun] = useState(false);
  const autoRunRef = useRef(false);
  useEffect(() => { autoRunRef.current = autoRun; }, [autoRun]);
  const handleRunRef = useRef<(() => void) | null>(null);

  // ── Terminal ──────────────────────────────────────────────────────────────
  const [terminalVisible, setTerminalVisible] = useState(false);
  const terminalVisibleRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const terminalAnim = useRef(new Animated.Value(0)).current;
  const termScrollRef = useRef<ScrollView>(null);
  const pendingLinesRef = useRef<TerminalLine[]>([]);
  const rafScheduledRef = useRef(false);
  // Stdin state
  const [runToken, setRunToken] = useState<string | null>(null);
  const runTokenRef = useRef<string | null>(null);
  const [stdinInput, setStdinInput] = useState('');

  // Serve state — long-lived server preview
  const [isServing, setIsServing] = useState(false);
  const [serveUrl, setServeUrl] = useState<string | null>(null);
  const [isServeLaunching, setIsServeLaunching] = useState(false);
  const [serveError, setServeError] = useState<string | null>(null);
  // Which pane is active inside the terminal panel when a server is running
  const [activePane, setActivePane] = useState<'terminal' | 'preview'>('terminal');
  // Key for the embedded serve preview — increment to force a reload
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

  // Terminal height — derived from the measured workspace panel, not full screen dims.
  // The workspace panel gets (containerMain - chatSize - 5px divider) of the split container.
  const workspaceMain = Math.max(0, containerMain - chatSize - 5);
  const TERMINAL_HEIGHT = Math.max(160, Math.round(workspaceMain * 0.45));

  // ── File modals ───────────────────────────────────────────────────────────
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileLang, setNewFileLang] = useState<'javascript' | 'typescript' | 'python' | 'bash' | 'plaintext' | 'go' | 'rust' | 'ruby' | 'java'>('javascript');
  const [renameFile, setRenameFile] = useState<ProjectFile | null>(null);
  const [renameFilePath, setRenameFilePath] = useState('');

  // ── Other modals ──────────────────────────────────────────────────────────
  const [exportOpen, setExportOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Deployed URL — persisted in AsyncStorage so it survives restarts
  const [deployedUrl, setDeployedUrl] = useState<string | null>(null);

  // Load saved deployed URL on mount
  useEffect(() => {
    AsyncStorage.getItem(`clownin_deployed_url_${projectId}`).then((u) => {
      if (u) setDeployedUrl(u);
    }).catch(() => {});
  }, [projectId]);

  const updateFileMutation = useUpdateFile();
  const createFileMutation = useCreateFile();
  const deleteFileMutation = useDeleteFile();

  // ── Restore file selection ────────────────────────────────────────────────
  useEffect(() => {
    if (project?.files && project.files.length > 0 && selectedFileId === null) {
      AsyncStorage.getItem(`selected_file_${projectId}`)
        .then((savedId) => {
          const savedFileId = savedId !== null ? parseInt(savedId, 10) : NaN;
          const restoredFile =
            !isNaN(savedFileId) && project.files.find((f) => f.id === savedFileId)
              ? project.files.find((f) => f.id === savedFileId)!
              : project.files[0];
          return AsyncStorage.getItem(`scroll_${projectId}_${restoredFile.id}`)
            .then((saved) => {
              const parsed = saved !== null ? parseFloat(saved) : NaN;
              sharedScrollY.current = isFinite(parsed) && parsed >= 0 ? parsed : 0;
            })
            .catch(() => { sharedScrollY.current = 0; })
            .finally(() => {
              setSelectedFileId(restoredFile.id);
              setEditorContent(restoredFile.content);
            });
        })
        .catch(() => {
          const first = project.files[0];
          sharedScrollY.current = 0;
          setSelectedFileId(first.id);
          setEditorContent(first.content);
        });
    }
  }, [project]);

  // ── Restore terminal visibility ───────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    AsyncStorage.getItem(`terminal_open_${projectId}`).then((val) => {
      if (val === 'true') {
        terminalVisibleRef.current = true;
        setTerminalVisible(true);
        terminalAnim.setValue(1);
      }
    }).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    terminalVisibleRef.current = terminalVisible;
    AsyncStorage.setItem(`terminal_open_${projectId}`, terminalVisible ? 'true' : 'false').catch(() => {});
  }, [terminalVisible, projectId]);

  // ── Flush pending save ────────────────────────────────────────────────────
  const flushPendingSave = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const content = pendingContentRef.current;
    const fileId = pendingFileIdRef.current;
    if (content === null || fileId === null) return;
    pendingContentRef.current = null;
    pendingFileIdRef.current = null;
    setIsSaving(true);
    try {
      await updateFileMutation.mutateAsync({ id: projectId, fileId, data: { content } });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    } catch { /* silent */ } finally { setIsSaving(false); }
  }, [projectId]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const content = pendingContentRef.current;
      const fileId = pendingFileIdRef.current;
      if (content !== null && fileId !== null) {
        updateFileMutation.mutateAsync({ id: projectId, fileId, data: { content } }).catch(() => {});
      }
      if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
      const pendingScroll = pendingScrollSaveRef.current;
      if (pendingScroll) {
        AsyncStorage.setItem(`scroll_${projectId}_${pendingScroll.fileId}`, String(pendingScroll.y)).catch(() => {});
      }
    };
  }, [projectId]);

  // ── Select file ───────────────────────────────────────────────────────────
  const selectFile = useCallback(async (file: ProjectFile) => {
    flushScrollSave();
    await flushPendingSave();
    setIsEditing(false);
    const saved = await AsyncStorage.getItem(`scroll_${projectId}_${file.id}`).catch(() => null);
    const parsed = saved !== null ? parseFloat(saved) : NaN;
    sharedScrollY.current = isFinite(parsed) && parsed >= 0 ? parsed : 0;
    setSelectedFileId(file.id);
    setEditorContent(file.content);
    AsyncStorage.setItem(`selected_file_${projectId}`, String(file.id)).catch(() => {});
    Haptics.selectionAsync();
    if (sidebarOpen && Platform.OS !== 'web') toggleSidebar();
  }, [sidebarOpen, flushPendingSave, flushScrollSave, projectId]);

  // ── Editor change ─────────────────────────────────────────────────────────
  const handleEditorChange = useCallback((text: string) => {
    setEditorContent(text);
    pendingContentRef.current = text;
    pendingFileIdRef.current = selectedFileId;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!selectedFileId) return;
      pendingContentRef.current = null;
      pendingFileIdRef.current = null;
      setIsSaving(true);
      try {
        await updateFileMutation.mutateAsync({ id: projectId, fileId: selectedFileId, data: { content: text } });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        if (autoRunRef.current) handleRunRef.current?.();
      } catch { /* silent */ } finally { setIsSaving(false); }
    }, 1500);
  }, [selectedFileId, projectId]);

  // ── Sidebar toggle ────────────────────────────────────────────────────────
  const toggleSidebar = () => {
    const toValue = sidebarOpen ? 0 : 1;
    Animated.timing(sidebarAnim, { toValue, duration: 220, useNativeDriver: false }).start();
    setSidebarOpen(!sidebarOpen);
  };

  // Keep runTokenRef in sync so sendStdin can read it without stale closure
  useEffect(() => { runTokenRef.current = runToken; }, [runToken]);

  // ── Stable addLine — usable outside handleRun (e.g. sendStdin echo) ───────
  const addLine = useCallback((type: TerminalLine['type'], text: string) => {
    const TERMINAL_MAX_LINES = 500;
    pendingLinesRef.current.push({ id: `${Date.now()}-${Math.random()}`, type, text });
    if (!rafScheduledRef.current) {
      rafScheduledRef.current = true;
      requestAnimationFrame(() => {
        rafScheduledRef.current = false;
        const batch = pendingLinesRef.current;
        if (batch.length === 0) return;
        pendingLinesRef.current = [];
        setTerminalLines((prev) => {
          const next = [...prev, ...batch];
          if (next.length > TERMINAL_MAX_LINES) {
            const trimmed = next.slice(next.length - TERMINAL_MAX_LINES);
            return [{ id: `trim-${Date.now()}`, type: 'system' as const, text: '— Earlier output cleared —' }, ...trimmed];
          }
          return next;
        });
        setTimeout(() => termScrollRef.current?.scrollToEnd({ animated: true }), 50);
      });
    }
  }, []);

  // ── Send stdin to the running process ─────────────────────────────────────
  // Echo happens only after the server confirms receipt (not optimistically),
  // so the user sees dropped input rather than false confirmation.
  // A 410 response means the run has ended — clear the token so the stdin
  // row disappears immediately.
  const sendStdin = useCallback(async (text: string) => {
    const currentToken = runTokenRef.current;
    if (!currentToken || !text) return;
    try {
      const response = await fetch(apiUrl(`/api/projects/${projectId}/stdin`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: currentToken, data: text }),
      });
      if (response.status === 204) {
        // Server accepted the input — now safe to echo
        addLine('input', `> ${text}`);
      } else if (response.status === 410) {
        // Run has ended — hide the input row
        setRunToken(null);
        runTokenRef.current = null;
      }
      // Other errors (403, 400, network): silently ignore — don't echo
    } catch { /* network error — don't echo */ }
  }, [addLine, projectId, token]);

  // ── Terminal ──────────────────────────────────────────────────────────────
  const openTerminal = useCallback(() => {
    setTerminalVisible(true);
    Animated.spring(terminalAnim, { toValue: 1, useNativeDriver: false, tension: 80, friction: 10 }).start();
  }, [terminalAnim]);

  const closeTerminal = useCallback(() => {
    Animated.timing(terminalAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start(() => setTerminalVisible(false));
  }, [terminalAnim]);

  // ── Run code ──────────────────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    if (!selectedFileId || !token) return;
    if (isRunningRef.current) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setTerminalLines((prev) =>
      prev.length > 0
        ? [...prev, { id: `sep-${Date.now()}`, type: 'system', text: '──────────────────────────' }]
        : prev
    );
    setExitCode(null);
    isRunningRef.current = true;
    setIsRunning(true);
    openTerminal();

    addLine('system', '$ Running...');
    const runStartTime = Date.now();

    try {
      const url = apiUrl(`/api/projects/${projectId}/execute`);
      const response = await expoFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fileId: selectedFileId }),
        // @ts-ignore expo fetch streaming
        reactNative: { textStreaming: true },
      });

      if (!response.ok) { addLine('stderr', `Error: ${await response.text()}`); setIsRunning(false); return; }

      const reader = response.body?.getReader();
      if (!reader) { addLine('stderr', 'Streaming not supported'); setIsRunning(false); return; }

      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6)) as { type: string; payload: string };
                if (event.type === 'token') {
                  setRunToken(event.payload);
                  runTokenRef.current = event.payload;
                } else if (event.type === 'stdout') {
                  const stripped = event.payload.replace(/\n$/, '');
                  if (stripped) addLine('stdout', stripped);
                } else if (event.type === 'stderr') {
                  const stripped = event.payload.replace(/\n$/, '');
                  if (stripped) addLine('stderr', stripped);
                } else if (event.type === 'system') {
                  const stripped = event.payload.replace(/\n$/, '');
                  if (stripped) addLine('system', stripped);
                } else if (event.type === 'exit') {
                  const code = parseInt(event.payload, 10);
                  setExitCode(code);
                  const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(2);
                  addLine('system', `\nProcess exited with code ${code}  (${elapsed}s)`);
                }
              } catch { /* skip */ }
            }
          }
        }
      }
    } catch (err: unknown) {
      addLine('stderr', err instanceof Error ? err.message : 'Execution failed');
    } finally {
      isRunningRef.current = false;
      setIsRunning(false);
      setRunToken(null);
      runTokenRef.current = null;
    }
  }, [selectedFileId, token, projectId, openTerminal, addLine]);

  useEffect(() => { handleRunRef.current = handleRun; }, [handleRun]);

  // ── Serve: helper to get the API base URL ──────────────────────────────────
  // The serve proxy intentionally requires a short-lived, project-bound
  // capability. Exchange the authenticated workspace session for that
  // capability before opening a preview in a browser or WebView; the proxy
  // immediately trades it for a restricted HTTP-only cookie.
  const getAuthorizedServeUrl = useCallback(async (url: string): Promise<string> => {
    if (!token) throw new Error('Sign in to open the live preview');

    const response = await fetch(apiUrl(`/api/projects/${projectId}/serve/preview-token`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Could not authorize preview (${response.status})`);

    const data = (await response.json()) as { token?: string };
    if (!data.token) throw new Error('Could not authorize preview');

    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}preview_token=${encodeURIComponent(data.token)}`;
  }, [token, projectId]);

  const recoverStartedServe = useCallback(async (): Promise<boolean> => {
    // The API can finish launching a sandbox after a browser proxy has already
    // closed the original start request. Check the owner-authenticated status
    // briefly so a live preview is not reported as a failed start.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await fetch(apiUrl(`/api/projects/${projectId}/serve`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const status = (await response.json()) as { running: boolean; url?: string };
          if (status.running && status.url) {
            setServeUrl(await getAuthorizedServeUrl(status.url));
            setIsServing(true);
            setIsServeLaunching(false);
            setServeError(null);
            setActivePane('preview');
            openTerminal();
            return true;
          }
        }
      } catch {
        // A launch still registering is retried below.
      }
      if (attempt < 5) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }, [token, projectId, getAuthorizedServeUrl, openTerminal]);

  // ── Clean install ──────────────────────────────────────────────────────────
  // Wipes node_modules / .venv so the next run reinstalls from scratch.
  const handleCleanInstall = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(apiUrl(`/api/projects/${projectId}/clean`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        addLine('system', '[Package cache cleared — packages will reinstall on next run]');
      } else {
        addLine('stderr', '[Failed to clear package cache]');
      }
    } catch {
      addLine('stderr', '[Failed to clear package cache: network error]');
    }
    openTerminal();
  }, [token, projectId, addLine, openTerminal]);

  const handleRunLongPress = useCallback(async () => {
    if (!hasDepFiles) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert(
      'Run options',
      undefined,
      [
        { text: 'Clean install', onPress: handleCleanInstall },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [hasDepFiles, handleCleanInstall]);

  // ── Serve: check whether a server is already running on mount ─────────────
  useEffect(() => {
    if (!token) return;
    fetch(apiUrl(`/api/projects/${projectId}/serve`), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then(async (data: { running: boolean; url?: string }) => {
        if (data.running && data.url) {
          const authorizedUrl = await getAuthorizedServeUrl(data.url);
          setIsServing(true);
          setServeUrl(authorizedUrl);
          setActivePane('preview');
          openTerminal();
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount

  // ── Serve: stream server logs via SSE while a server is running ────────────
  useEffect(() => {
    if (!isServing || !token) return;
    let aborted = false;

    (async () => {
      try {
        const url = apiUrl(`/api/projects/${projectId}/serve/logs`);
        const response = await expoFetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          // @ts-ignore expo fetch streaming
          reactNative: { textStreaming: true },
        });
        if (!response.ok || aborted) return;

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';
        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            for (const rawLine of part.split('\n')) {
              if (!rawLine.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(rawLine.slice(6)) as { type: string; payload: string };
                if (event.type === 'url') {
                  void getAuthorizedServeUrl(event.payload)
                    .then((authorizedUrl) => {
                      if (aborted) return;
                      setServeUrl(authorizedUrl);
                      setActivePane('preview');
                      openTerminal();
                    })
                    .catch((err: unknown) => {
                      if (!aborted) {
                        addLine('stderr', `[Preview authorization failed: ${err instanceof Error ? err.message : String(err)}]`);
                      }
                    });
                } else if (event.type === 'stdout') {
                  const s = event.payload.replace(/\n$/, '');
                  if (s) addLine('stdout', s);
                } else if (event.type === 'stderr') {
                  const s = event.payload.replace(/\n$/, '');
                  if (s) addLine('stderr', s);
                } else if (event.type === 'system') {
                  addLine('system', event.payload);
                } else if (event.type === 'exit') {
                  addLine('system', `[Server stopped (exit ${event.payload})]`);
                  setIsServing(false);
                  setServeUrl(null);
                  setActivePane('terminal');
                }
              } catch { /* skip malformed */ }
            }
          }
        }
      } catch (err: unknown) {
        if (!aborted) {
          addLine('stderr', err instanceof Error ? err.message : 'Serve log stream error');
        }
      }
    })();

    return () => { aborted = true; };
  }, [isServing, token, projectId, addLine, getAuthorizedServeUrl, openTerminal]);

  // ── Start a long-lived server process ─────────────────────────────────────
  const handleServe = useCallback(async () => {
    if (!selectedFileId || !token || isServeLaunching || isServing) return;
    setIsServeLaunching(true);
    setServeUrl(null);
    setServeError(null);
    setActivePane('preview');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    openTerminal();
    addLine('system', '$ Starting server…');
    try {
      const response = await fetch(apiUrl(`/api/projects/${projectId}/serve`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fileId: selectedFileId }),
      });
      if (!response.ok) {
        const err = (await response.json()) as { error?: string };
        if (await recoverStartedServe()) return;
        addLine('stderr', `[Serve failed: ${err.error ?? response.status}]`);
        return;
      }
      const data = (await response.json()) as { url: string; port: number };
      const authorizedUrl = await getAuthorizedServeUrl(data.url);
      setIsServing(true);
      setServeUrl(authorizedUrl);
      setServeError(null);
      setActivePane('preview');
    } catch (err: unknown) {
      if (await recoverStartedServe()) return;
      const message = err instanceof Error ? err.message : 'Could not start the server. Try again.';
      addLine('stderr', `[Serve error: ${message}]`);
      setServeError(message);
    } finally {
      setIsServeLaunching(false);
    }
  }, [selectedFileId, token, projectId, isServeLaunching, isServing, openTerminal, addLine, getAuthorizedServeUrl, recoverStartedServe]);

  // ── Stop the running server ────────────────────────────────────────────────
  const handleStopServe = useCallback(async () => {
    if (!token) return;
    setIsServing(false);
    setIsServeLaunching(false);
    setServeUrl(null);
    setServeError(null);
    setActivePane('terminal');
    addLine('system', '[Stopping server…]');
    try {
      await fetch(apiUrl(`/api/projects/${projectId}/serve`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* best effort */ }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [token, projectId, addLine]);

  // ── Create file ───────────────────────────────────────────────────────────
  const handleCreateFile = async () => {
    if (!newFilePath.trim()) return;
    try {
      const file = await createFileMutation.mutateAsync({
        id: projectId,
        data: { path: newFilePath.trim(), content: '', language: newFileLang },
      });
      await queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      setShowNewFile(false);
      setNewFilePath('');
      setSelectedFileId(file.id);
      setEditorContent('');
      AsyncStorage.setItem(`selected_file_${projectId}`, String(file.id)).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to create file');
    }
  };

  // ── Rename file ───────────────────────────────────────────────────────────
  const handleRenameFile = async () => {
    if (!renameFile || !renameFilePath.trim()) return;
    try {
      await updateFileMutation.mutateAsync({ id: projectId, fileId: renameFile.id, data: { path: renameFilePath.trim() } });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      setRenameFile(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to rename file');
    }
  };

  // ── Delete file ───────────────────────────────────────────────────────────
  const handleDeleteFile = (file: ProjectFile) => {
    Alert.alert('Delete File', `Delete "${file.path}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteFileMutation.mutateAsync({ id: projectId, fileId: file.id });
            queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
            AsyncStorage.removeItem(`scroll_${projectId}_${file.id}`).catch(() => {});
            if (selectedFileId === file.id) {
              AsyncStorage.removeItem(`selected_file_${projectId}`).catch(() => {});
              setSelectedFileId(null);
              setEditorContent('');
            }
          } catch {
            Alert.alert('Error', 'Failed to delete file');
          }
        },
      },
    ]);
  };

  const selectedFile = project?.files.find((f) => f.id === selectedFileId);
  const RUNNABLE_LANGS = new Set(["javascript", "typescript", "python", "bash", "js", "ts", "py", "sh"]);
  const SERVEABLE_LANGS = new Set(["javascript", "typescript", "python", "js", "ts", "py"]);
  const canRun = selectedFile ? RUNNABLE_LANGS.has(selectedFile.language) : false;
  const canServe = selectedFile ? SERVEABLE_LANGS.has(selectedFile.language) : false;
  const canPreview = selectedFile?.language === "html" || selectedFile?.path.endsWith(".html");
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const sidebarWidth = sidebarAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 160] });

  const onFilesChanged = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
  }, [queryClient, projectId]);

  if (isLoading) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>

      {/* ── Header ────────────────────────────────────────────────── */}
      <View style={[styles.header, { paddingTop: topPad + 8, borderBottomColor: colors.border, backgroundColor: colors.card }]}>
        <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={colors.foreground} />
        </Pressable>

        <Pressable style={styles.headerBtn} onPress={toggleSidebar} hitSlop={8}>
          <Ionicons name={sidebarOpen ? 'folder-open-outline' : 'folder-outline'} size={20} color={colors.foreground} />
        </Pressable>

        <View style={styles.headerTitle}>
          <Text style={[styles.projectName, { color: colors.foreground }]} numberOfLines={1}>
            {project?.name ?? ''}
          </Text>
          {selectedFile && (
            <Text style={[styles.fileName, { color: colors.mutedForeground }]} numberOfLines={1}>
              {selectedFile.path}
            </Text>
          )}
        </View>

        {isSaving && <ActivityIndicator size="small" color={colors.mutedForeground} style={styles.saveIndicator} />}

        {canPreview && (
          <Pressable
            style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => setPreviewOpen(true)}
            hitSlop={4}
          >
            <MaterialCommunityIcons name="eye-outline" size={17} color={colors.primary} />
          </Pressable>
        )}

        {canRun && (
          <Pressable
            style={[
              styles.autoRunBtn,
              { backgroundColor: autoRun ? colors.primary + '22' : 'transparent', borderColor: autoRun ? colors.primary : colors.border },
            ]}
            onPress={() => { setAutoRun((v) => !v); Haptics.selectionAsync(); }}
            hitSlop={6}
          >
            <Feather name="zap" size={13} color={autoRun ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.autoRunLabel, { color: autoRun ? colors.primary : colors.mutedForeground }]}>Auto</Text>
          </Pressable>
        )}

        <Pressable
          style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setShareOpen(true)}
          hitSlop={4}
        >
          <Ionicons name="share-outline" size={18} color={colors.foreground} />
        </Pressable>

        <Pressable
          testID="build-and-deploy-button"
          style={[styles.buildDeployBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
          onPress={() => setDeployOpen(true)}
          hitSlop={4}
        >
          <MaterialCommunityIcons name="rocket-launch-outline" size={15} color={colors.primaryForeground} />
          <Text style={[styles.buildDeployText, { color: colors.primaryForeground }]}>Build</Text>
        </Pressable>

        <Pressable
          style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => router.push({ pathname: '/project-env', params: { projectId: String(projectId) } })}
          hitSlop={4}
        >
          <MaterialCommunityIcons name="key-outline" size={17} color={colors.mutedForeground} />
        </Pressable>

        <Pressable
          style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={handlePickServer}
          hitSlop={4}
        >
          <MaterialCommunityIcons
            name="server-outline"
            size={17}
            color={project?.serverId ? colors.primary : colors.mutedForeground}
          />
        </Pressable>

        <Pressable
          style={[styles.headerIconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setExportOpen(true)}
          hitSlop={4}
        >
          <MaterialCommunityIcons name="github" size={18} color={colors.foreground} />
        </Pressable>

        {/* Deploy button — shows live indicator dot when a deploy URL exists */}
        <Pressable
          style={[
            styles.headerIconBtn,
            {
              backgroundColor: deployedUrl ? '#0d2417' : colors.card,
              borderColor: deployedUrl ? '#3fb950' : colors.border,
            },
          ]}
          onPress={() => setDeployOpen(true)}
          hitSlop={4}
        >
          <MaterialCommunityIcons
            name="rocket-launch-outline"
            size={17}
            color={deployedUrl ? '#3fb950' : colors.foreground}
          />
        </Pressable>

        {canServe && (
          <Pressable
            style={[
              styles.headerIconBtn,
              {
                backgroundColor: isServing ? '#0d2417' : colors.card,
                borderColor: isServing ? '#3fb950' : colors.border,
              },
            ]}
            onPress={isServing ? handleStopServe : handleServe}
            disabled={isServeLaunching || (!isServing && !selectedFileId)}
            hitSlop={4}
          >
            {isServeLaunching
              ? <ActivityIndicator size="small" color={colors.primary} />
              : isServing
                ? <Ionicons name="stop-circle-outline" size={18} color="#3fb950" />
                : <Ionicons name="globe-outline" size={18} color={colors.foreground} />
            }
          </Pressable>
        )}

        {canRun && (
          <Pressable
            style={[styles.runBtn, { backgroundColor: isRunning ? colors.muted : colors.primary }]}
            onPress={handleRun}
            onLongPress={hasDepFiles && !isRunning ? handleRunLongPress : undefined}
            delayLongPress={600}
            disabled={isRunning || !selectedFileId}
          >
            {isRunning
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="play" size={16} color={colors.primaryForeground} />
            }
          </Pressable>
        )}
      </View>

      {/* ── Split-screen body ─────────────────────────────────────── */}
      <View
        style={[styles.splitContainer, { flexDirection: isLandscape ? 'row' : 'column' }]}
        onLayout={onSplitContainerLayout}
      >

        {/* Chat panel */}
        <View
          style={[
            styles.chatPane,
            isLandscape
              ? { width: chatSize, borderRightWidth: 1, borderRightColor: colors.border }
              : { height: chatSize, borderBottomWidth: 1, borderBottomColor: colors.border },
            { backgroundColor: colors.background },
          ]}
        >
          <AgentChat
            projectId={projectId}
            onFilesChanged={onFilesChanged}
            initialMessage={initialMessage}
          />
        </View>

        {/* Draggable divider */}
        <View
          style={[
            styles.divider,
            isLandscape ? styles.dividerVertical : styles.dividerHorizontal,
          ]}
          {...panResponder.panHandlers}
        >
          {/* Grip dots */}
          <View style={[styles.dividerGrip, isLandscape && styles.dividerGripV]}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.gripDot, { backgroundColor: colors.mutedForeground }]} />
            ))}
          </View>
        </View>

        {/* Workspace panel */}
        <View style={[styles.workspacePane, { backgroundColor: colors.background }]}>
          {/* Sidebar + editor */}
          <View style={styles.body}>
            {/* Sidebar */}
            <Animated.View
              style={[
                styles.sidebar,
                { width: sidebarWidth, borderRightColor: colors.border, backgroundColor: colors.card },
              ]}
            >
              <View style={[styles.sidebarHeader, { borderBottomColor: colors.border }]}>
                <Text style={[styles.sidebarTitle, { color: colors.mutedForeground }]}>FILES</Text>
                <Pressable onPress={() => setShowNewFile(true)} hitSlop={8}>
                  <Ionicons name="add" size={18} color={colors.primary} />
                </Pressable>
              </View>
              <FlatList
                data={project?.files ?? []}
                keyExtractor={(item) => String(item.id)}
                style={styles.fileList}
                contentContainerStyle={{ padding: 6, gap: 2 }}
                scrollEnabled={!!(project?.files && project.files.length > 4)}
                renderItem={({ item }) => (
                  <FileItem
                    file={item}
                    selected={item.id === selectedFileId}
                    onSelect={() => selectFile(item)}
                    onLongPress={() => { setRenameFile(item); setRenameFilePath(item.path); }}
                    onDelete={() => handleDeleteFile(item)}
                    colors={colors}
                  />
                )}
                ListEmptyComponent={
                  <Text style={[styles.noFiles, { color: colors.mutedForeground }]}>No files</Text>
                }
              />
            </Animated.View>

            {/* Code editor */}
            <View style={[styles.editorPane, { backgroundColor: colors.background }]}>
              {selectedFile ? (
                isEditing ? (
                  <TextInput
                    ref={codeInputRef}
                    style={[styles.codeInput, { color: colors.foreground, backgroundColor: colors.background }]}
                    value={editorContent}
                    onChangeText={handleEditorChange}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    textAlignVertical="top"
                    scrollEnabled
                    onScroll={(e) => {
                      const y = e.nativeEvent?.contentOffset?.y ?? 0;
                      sharedScrollY.current = y;
                      if (selectedFileId) saveScrollOffset(selectedFileId, y);
                    }}
                    keyboardType="default"
                    placeholder="// Start coding..."
                    placeholderTextColor={colors.mutedForeground}
                    autoFocus
                    selection={pendingSelection}
                    onSelectionChange={(e) => {
                      setPendingSelection(undefined);
                      const start = e.nativeEvent.selection.start;
                      cursorLineRef.current = editorContent.slice(0, start).split('\n').length - 1;
                    }}
                    onBlur={() => setIsEditing(false)}
                  />
                ) : (
                  editorContent.length === 0 ? (
                    <Pressable
                      style={styles.editorPane}
                      onPress={() => { setIsEditing(true); setTimeout(() => codeInputRef.current?.focus(), 50); }}
                    >
                      <Text style={[styles.codeInput, { color: colors.mutedForeground }]}>// Start coding...</Text>
                    </Pressable>
                  ) : (
                    <SyntaxHighlighter
                      key={selectedFileId}
                      code={editorContent}
                      language={selectedFile.language}
                      scrollRef={viewScrollRef}
                      initialScrollY={sharedScrollY.current}
                      onScrollY={(y) => { sharedScrollY.current = y; if (selectedFileId) saveScrollOffset(selectedFileId, y); }}
                      onLinePress={(lineIndex) => {
                        const codeLines = editorContent.split('\n');
                        const charOffset = codeLines.slice(0, lineIndex).reduce((sum, l) => sum + l.length + 1, 0);
                        pendingScrollLineRef.current = lineIndex;
                        setPendingSelection({ start: charOffset, end: charOffset });
                        setIsEditing(true);
                        setTimeout(() => codeInputRef.current?.focus(), 50);
                      }}
                    />
                  )
                )
              ) : (
                <View style={styles.noFileSelected}>
                  <Feather name="file-text" size={40} color={colors.border} />
                  <Text style={[styles.noFileText, { color: colors.mutedForeground }]}>Select a file to edit</Text>
                </View>
              )}
            </View>
          </View>

          {/* Terminal panel — contained within workspace */}
          {terminalVisible && (
            <Animated.View
              style={[
                styles.terminal,
                {
                  backgroundColor: '#0a0f14',
                  borderTopColor: colors.border,
                  height: terminalAnim.interpolate({ inputRange: [0, 1], outputRange: [0, TERMINAL_HEIGHT] }),
                },
              ]}
            >
              <View style={[styles.termHeader, { borderBottomColor: colors.border }]}>
                {/* Left: tab switcher when serving, macOS dots otherwise */}
                <View style={styles.termHeaderLeft}>
                  {isServing && serveUrl ? (
                    <View style={styles.termTabs}>
                      <Pressable
                        style={[styles.termTab, activePane === 'terminal' && styles.termTabActive]}
                        onPress={() => setActivePane('terminal')}
                        hitSlop={6}
                      >
                        <Text style={[styles.termTabText, { color: activePane === 'terminal' ? '#e6edf3' : '#8b949e' }]}>
                          Terminal
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.termTab, activePane === 'preview' && styles.termTabActiveGreen]}
                        onPress={() => setActivePane('preview')}
                        hitSlop={6}
                      >
                        <View style={[styles.termLiveDot, { backgroundColor: '#3fb950' }]} />
                        <Text style={[styles.termTabText, { color: activePane === 'preview' ? '#3fb950' : '#8b949e' }]}>
                          Preview
                        </Text>
                      </Pressable>
                    </View>
                  ) : (
                    <>
                      <View style={[styles.termDot, { backgroundColor: '#f85149' }]} />
                      <View style={[styles.termDot, { backgroundColor: '#d29922' }]} />
                      <View style={[styles.termDot, { backgroundColor: '#3fb950' }]} />
                      <Text style={[styles.termTitle, { color: '#8b949e' }]}>Terminal</Text>
                    </>
                  )}
                </View>
                <View style={styles.termHeaderRight}>
                  {/* Reload + open-externally buttons in preview tab */}
                  {isServing && serveUrl && activePane === 'preview' && (
                    <>
                      <Pressable
                        onPress={() => setPreviewReloadKey((k) => k + 1)}
                        style={styles.termBtn}
                        hitSlop={8}
                      >
                        <Ionicons name="refresh-outline" size={15} color="#8b949e" />
                      </Pressable>
                      <Pressable
                        onPress={() => Linking.openURL(serveUrl)}
                        style={styles.termBtn}
                        hitSlop={8}
                      >
                        <Ionicons name="open-outline" size={15} color="#8b949e" />
                      </Pressable>
                    </>
                  )}
                  {exitCode !== null && !isServing && (
                    <View style={[styles.exitBadge, { backgroundColor: exitCode === 0 ? '#3fb95022' : '#f8514922', borderColor: exitCode === 0 ? '#3fb95055' : '#f8514955' }]}>
                      <Text style={[styles.exitText, { color: exitCode === 0 ? '#3fb950' : '#f85149' }]}>exit {exitCode}</Text>
                    </View>
                  )}
                  <Pressable onPress={() => setTerminalLines([])} style={styles.termBtn} hitSlop={8}>
                    <Feather name="trash-2" size={14} color="#8b949e" />
                  </Pressable>
                  <Pressable onPress={closeTerminal} style={styles.termBtn} hitSlop={8}>
                    <Ionicons name="chevron-down" size={18} color="#8b949e" />
                  </Pressable>
                </View>
              </View>

              {/* ── Compact URL strip — only in terminal tab so users can copy/open ── */}
              {isServing && serveUrl && activePane === 'terminal' && (
                <Pressable
                  style={styles.serveBanner}
                  onPress={() => Linking.openURL(serveUrl)}
                >
                  <View style={[styles.serveLiveDot, { backgroundColor: '#3fb950' }]} />
                  <Text style={styles.serveUrlText} numberOfLines={1}>{serveUrl}</Text>
                  <Ionicons name="open-outline" size={12} color="#3fb950" />
                </Pressable>
              )}

              {/* ── Embedded preview WebView ── */}
              {activePane === 'preview' && (isServeLaunching || Boolean(serveError) || (isServing && serveUrl)) && (
                <ServePreview
                  url={serveUrl}
                  isStarting={isServeLaunching}
                  error={serveError}
                  onRetry={handleServe}
                  reloadKey={previewReloadKey}
                />
              )}

              <ScrollView
                ref={termScrollRef}
                style={[styles.termOutput, activePane === 'preview' && { display: 'none' }]}
                contentContainerStyle={{ padding: 12, paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 12 }}
              >
                {terminalLines.map((line) => (
                  <Text
                    key={line.id}
                    style={[
                      styles.termLine,
                      line.type === 'stdout' && { color: '#e6edf3' },
                      line.type === 'stderr' && { color: '#f85149' },
                      line.type === 'system' && { color: '#8b949e', fontStyle: 'italic' },
                      line.type === 'input' && { color: '#79c0ff' },
                    ]}
                  >
                    {line.text}
                  </Text>
                ))}
                {isRunning && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <ActivityIndicator size="small" color="#3fb950" />
                    <Text style={{ color: '#3fb950', fontSize: 12, fontFamily: 'Inter_400Regular' }}>Running...</Text>
                  </View>
                )}
              </ScrollView>

              {/* ── Stdin input row — only shown once the run token is
                  received, guaranteeing the process is registered and
                  ready for input before the user can submit anything. ── */}
              {isRunning && !!runToken && (
                <View style={[styles.stdinRow, { borderTopColor: '#21262d' }]}>
                  {/* ⌃C — send SIGINT via the cancel endpoint */}
                  <Pressable
                    onPress={async () => {
                      const currentToken = runTokenRef.current;
                      if (!currentToken || !token) return;
                      try {
                        await fetch(apiUrl(`/api/projects/${projectId}/execute/cancel`), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ token: currentToken }),
                        });
                      } catch { /* ignore — process will time out naturally */ }
                    }}
                    style={[styles.stdinSendBtn, { marginRight: 0, backgroundColor: '#f8514922', borderRadius: 6, paddingHorizontal: 8 }]}
                    hitSlop={8}
                  >
                    <Text style={{ color: '#f85149', fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>⌃C</Text>
                  </Pressable>
                  <TextInput
                    style={[styles.stdinInput, { color: '#e6edf3', backgroundColor: '#161b22' }]}
                    value={stdinInput}
                    onChangeText={setStdinInput}
                    placeholder="Send input…"
                    placeholderTextColor="#4d5566"
                    returnKeyType="send"
                    blurOnSubmit={false}
                    onSubmitEditing={() => {
                      const text = stdinInput;
                      if (text !== '') {
                        sendStdin(text);
                        setStdinInput('');
                      }
                    }}
                  />
                  <Pressable
                    onPress={() => {
                      const text = stdinInput;
                      if (text !== '') {
                        sendStdin(text);
                        setStdinInput('');
                      }
                    }}
                    style={styles.stdinSendBtn}
                    hitSlop={8}
                  >
                    <Ionicons name="send" size={16} color="#3fb950" />
                  </Pressable>
                </View>
              )}
            </Animated.View>
          )}

          {/* Show terminal button */}
          {!terminalVisible && (
            <Pressable
              style={[styles.termToggle, { backgroundColor: colors.card, borderTopColor: colors.border }]}
              onPress={openTerminal}
            >
              <Text style={[styles.termToggleText, { color: colors.mutedForeground }]}>Terminal</Text>
              <Ionicons name="chevron-up" size={16} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>

      {/* ── Modals ────────────────────────────────────────────────── */}

      <InAppPreview
        visible={previewOpen}
        onClose={() => setPreviewOpen(false)}
        html={selectedFile?.content ?? ""}
        fileName={selectedFile?.path ?? ""}
      />

      <DeployModal
        visible={deployOpen}
        onClose={() => setDeployOpen(false)}
        projectId={projectId}
        projectName={project?.name ?? 'my-project'}
        hasUbuntuServer={!!project?.serverId}
        canDeployToUbuntu={canServe && !!selectedFileId}
        onDeployToUbuntu={handleServe}
        onOpenUbuntuSetup={() => {
          if (project?.serverId) {
            Alert.alert(
              'Choose a server file',
              'Select a JavaScript, TypeScript, or Python file that starts your web server, then try again.',
            );
            return;
          }
          router.push('/(app)/servers');
        }}
        onDeploySuccess={(url) => setDeployedUrl(url)}
        onOpenEasBuilds={() => router.push('/(app)/eas-builds')}
      />

      <GitHubExportModal
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        projectId={projectId}
        projectName={project?.name ?? 'my-project'}
      />

      <SharePreviewModal
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        projectId={projectId}
        projectName={project?.name ?? 'my-project'}
        hasHtmlFile={!!(project?.files.some((f) => f.path.endsWith('.html')))}
        onOpenDeploy={() => setDeployOpen(true)}
      />

      {/* Rename file modal */}
      <Modal visible={!!renameFile} transparent animationType="fade" onRequestClose={() => setRenameFile(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setRenameFile(null)}>
          <Pressable style={[styles.modalBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Rename File</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
              placeholder={renameFile?.path}
              placeholderTextColor={colors.mutedForeground}
              value={renameFilePath}
              onChangeText={setRenameFilePath}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleRenameFile}
            />
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, { borderColor: colors.border }]} onPress={() => setRenameFile(null)}>
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                onPress={handleRenameFile}
                disabled={updateFileMutation.isPending}
              >
                {updateFileMutation.isPending
                  ? <ActivityIndicator size="small" color={colors.primaryForeground} />
                  : <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>Rename</Text>
                }
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* New file modal */}
      <Modal visible={showNewFile} transparent animationType="fade" onRequestClose={() => setShowNewFile(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowNewFile(false)}>
          <Pressable style={[styles.modalBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>New File</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
              placeholder="filename.js"
              placeholderTextColor={colors.mutedForeground}
              value={newFilePath}
              onChangeText={setNewFilePath}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleCreateFile}
            />
            <Text style={[styles.langLabel, { color: colors.mutedForeground }]}>Language</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.langRow}>
              {([
                { id: 'javascript', label: 'JS' },
                { id: 'typescript', label: 'TS' },
                { id: 'python', label: 'PY' },
                { id: 'bash', label: 'SH' },
                { id: 'go', label: 'GO' },
                { id: 'rust', label: 'RS' },
                { id: 'ruby', label: 'RB' },
                { id: 'java', label: 'JV' },
                { id: 'plaintext', label: 'TXT' },
              ] as const).map(({ id: lang, label }) => (
                <Pressable
                  key={lang}
                  style={[
                    styles.langChip,
                    {
                      backgroundColor: newFileLang === lang ? colors.primary : colors.secondary,
                      borderColor: newFileLang === lang ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => setNewFileLang(lang)}
                >
                  <Text style={[styles.langChipText, { color: newFileLang === lang ? colors.primaryForeground : colors.foreground }]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, { borderColor: colors.border }]} onPress={() => setShowNewFile(false)}>
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                onPress={handleCreateFile}
                disabled={createFileMutation.isPending}
              >
                <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>Create</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    gap: 6,
  },
  headerBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  headerTitle: { flex: 1, minWidth: 0 },
  projectName: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  fileName: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  saveIndicator: { marginRight: 2 },
  autoRunBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 7, paddingVertical: 5, borderRadius: 8, borderWidth: 1,
  },
  autoRunLabel: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  headerIconBtn: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  buildDeployBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, borderWidth: 1,
    paddingHorizontal: 9, height: 34,
  },
  buildDeployText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  runBtn: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  // Split layout
  splitContainer: { flex: 1, overflow: 'hidden' },
  chatPane: { overflow: 'hidden' },
  divider: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    zIndex: 10,
  },
  dividerHorizontal: { height: 5, width: '100%', flexDirection: 'row' },
  dividerVertical: { width: 5, height: '100%', flexDirection: 'column' },
  dividerGrip: { flexDirection: 'row', gap: 3, alignItems: 'center' },
  dividerGripV: { flexDirection: 'column' },
  gripDot: { width: 3, height: 3, borderRadius: 1.5, opacity: 0.5 },

  workspacePane: { flex: 1, overflow: 'hidden' },

  // Sidebar + editor
  body: { flex: 1, flexDirection: 'row', overflow: 'hidden' },
  sidebar: { overflow: 'hidden', borderRightWidth: 1 },
  sidebarHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1,
  },
  sidebarTitle: { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 1 },
  fileList: { flex: 1 },
  noFiles: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 16 },
  editorPane: { flex: 1 },
  codeInput: {
    flex: 1, padding: 14, fontSize: 13, lineHeight: CODE_LINE_HEIGHT,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  noFileSelected: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  noFileText: { fontSize: 14, fontFamily: 'Inter_400Regular' },

  // Terminal
  terminal: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopWidth: 1, overflow: 'hidden' },
  termHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1,
  },
  termHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  termDot: { width: 10, height: 10, borderRadius: 5 },
  termTitle: { fontSize: 11, fontFamily: 'Inter_500Medium', marginLeft: 8, letterSpacing: 0.5 },
  termHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  exitBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  exitText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  termBtn: { padding: 2 },
  termOutput: { flex: 1 },
  termLine: {
    fontSize: 12, lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  termToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 16, gap: 6, borderTopWidth: 1,
  },
  termToggleText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  stdinRow: {
    flexDirection: 'row', alignItems: 'center',
    borderTopWidth: 1, paddingHorizontal: 10, paddingVertical: 6, gap: 8,
  },
  stdinInput: {
    flex: 1, fontSize: 12, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 6, borderWidth: 1, borderColor: '#30363d',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  stdinSendBtn: { padding: 6 },

  // Terminal pane tab switcher
  termTabs: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  termTab: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6,
  },
  termTabActive: { backgroundColor: '#21262d' },
  termTabActiveGreen: { backgroundColor: '#0d2417' },
  termTabText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.2 },
  termLiveDot: { width: 6, height: 6, borderRadius: 3 },

  // Serve URL banner (inside terminal panel)
  serveBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 7,
    backgroundColor: '#0d2417', borderBottomWidth: 1, borderBottomColor: '#1a4020',
  },
  serveLiveDot: { width: 7, height: 7, borderRadius: 4 },
  serveUrlText: {
    flex: 1, fontSize: 11, color: '#3fb950',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  modalBox: { width: 300, borderRadius: 16, borderWidth: 1, padding: 20, gap: 10 },
  modalTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  modalInput: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  langLabel: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  langRow: { flexDirection: 'row', gap: 6 },
  langChip: { minWidth: 44, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, alignItems: 'center' },
  langChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  modalActions: { flexDirection: 'row', gap: 8 },
  modalBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  modalBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});
