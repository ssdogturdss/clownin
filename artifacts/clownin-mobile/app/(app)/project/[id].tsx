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
  Dimensions,
  KeyboardAvoidingView,
} from 'react-native';
import { SyntaxHighlighter } from '@/components/SyntaxHighlighter';
import { router, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useGetProject,
  useCreateFile,
  useUpdateFile,
  useDeleteFile,
  getGetProjectQueryKey,
} from '@workspace/api-client-react';
import type { ProjectFile } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { fetch as expoFetch } from 'expo/fetch';

// ─── Terminal types ───────────────────────────────────────────────────────────
type TerminalLine = { id: string; type: 'stdout' | 'stderr' | 'system'; text: string };

// ─── Language icon helper ─────────────────────────────────────────────────────
function langIcon(language: string) {
  if (language === 'python') return 'language-python';
  if (language === 'typescript') return 'language-typescript';
  return 'language-javascript';
}

// ─── File-tree item ───────────────────────────────────────────────────────────
function FileItem({
  file,
  selected,
  onSelect,
  onDelete,
  colors,
}: {
  file: ProjectFile;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      style={[
        fileStyles.item,
        selected && { backgroundColor: colors.primary + '22' },
      ]}
      onPress={onSelect}
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
      <Pressable onPress={onDelete} hitSlop={8} style={fileStyles.deleteBtn}>
        <Ionicons name="trash-outline" size={12} color={colors.destructive} />
      </Pressable>
    </Pressable>
  );
}

const fileStyles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 },
  name: { flex: 1, fontSize: 12, fontFamily: 'Inter_400Regular' },
  deleteBtn: { padding: 2 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const TERMINAL_HEIGHT = Math.round(SCREEN_HEIGHT * 0.4);

export default function ProjectEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = Number(id);
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { data: project, isLoading } = useGetProject(projectId);

  // Selected file state
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Syntax-highlight editing mode
  const [isEditing, setIsEditing] = useState(false);
  const codeInputRef = useRef<TextInput>(null);
  // Cursor position to apply when entering edit mode from a line tap
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  // Refs for flushing pending saves before file switches
  const pendingContentRef = useRef<string | null>(null);
  const pendingFileIdRef = useRef<number | null>(null);

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarAnim = useRef(new Animated.Value(1)).current;

  // Auto-run on save
  const [autoRun, setAutoRun] = useState(false);
  const autoRunRef = useRef(false);
  useEffect(() => { autoRunRef.current = autoRun; }, [autoRun]);
  // Stable ref to handleRun so debounce always calls the latest version
  const handleRunRef = useRef<(() => void) | null>(null);

  // Terminal
  const [terminalVisible, setTerminalVisible] = useState(false);
  const terminalVisibleRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const terminalAnim = useRef(new Animated.Value(0)).current;
  const termScrollRef = useRef<ScrollView>(null);

  // New file modal
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileLang, setNewFileLang] = useState<'javascript' | 'python' | 'plaintext'>('javascript');

  const updateFileMutation = useUpdateFile();
  const createFileMutation = useCreateFile();
  const deleteFileMutation = useDeleteFile();

  // Select file on load
  useEffect(() => {
    if (project?.files && project.files.length > 0 && selectedFileId === null) {
      const first = project.files[0];
      setSelectedFileId(first.id);
      setEditorContent(first.content);
    }
  }, [project]);

  // Restore terminal open/closed state from AsyncStorage per project
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

  // Persist terminal visibility to AsyncStorage whenever it changes
  useEffect(() => {
    if (!projectId) return;
    terminalVisibleRef.current = terminalVisible;
    AsyncStorage.setItem(`terminal_open_${projectId}`, terminalVisible ? 'true' : 'false').catch(() => {});
  }, [terminalVisible, projectId]);

  // Flush any pending unsaved content immediately (fire-and-forget)
  const flushPendingSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const content = pendingContentRef.current;
    const fileId = pendingFileIdRef.current;
    if (content === null || fileId === null) return;
    pendingContentRef.current = null;
    pendingFileIdRef.current = null;
    setIsSaving(true);
    try {
      await updateFileMutation.mutateAsync({
        id: projectId,
        fileId,
        data: { content },
      });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    } catch {
      // silent save fail — content is still in state for the user to retry
    } finally {
      setIsSaving(false);
    }
  }, [projectId]);

  // Flush on unmount so navigation away doesn't lose edits
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const content = pendingContentRef.current;
      const fileId = pendingFileIdRef.current;
      if (content !== null && fileId !== null) {
        updateFileMutation.mutateAsync({ id: projectId, fileId, data: { content } }).catch(() => {});
      }
    };
  }, [projectId]);

  // When user selects a different file — flush first so no edits are lost
  const selectFile = useCallback(async (file: ProjectFile) => {
    await flushPendingSave();
    setIsEditing(false);
    setSelectedFileId(file.id);
    setEditorContent(file.content);
    Haptics.selectionAsync();
    if (sidebarOpen && Platform.OS !== 'web') {
      toggleSidebar();
    }
  }, [sidebarOpen, flushPendingSave]);

  // Debounce-save editor content
  const handleEditorChange = useCallback((text: string) => {
    setEditorContent(text);
    // Track latest unsaved state in refs so flushPendingSave always sees fresh values
    pendingContentRef.current = text;
    pendingFileIdRef.current = selectedFileId;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!selectedFileId) return;
      pendingContentRef.current = null;
      pendingFileIdRef.current = null;
      setIsSaving(true);
      try {
        await updateFileMutation.mutateAsync({
          id: projectId,
          fileId: selectedFileId,
          data: { content: text },
        });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        // Auto-run after successful save if toggle is on
        if (autoRunRef.current) {
          handleRunRef.current?.();
        }
      } catch {
        // silent save fail
      } finally {
        setIsSaving(false);
      }
    }, 1500);
  }, [selectedFileId, projectId]);

  // Sidebar toggle
  const toggleSidebar = () => {
    const toValue = sidebarOpen ? 0 : 1;
    Animated.timing(sidebarAnim, {
      toValue,
      duration: 220,
      useNativeDriver: false,
    }).start();
    setSidebarOpen(!sidebarOpen);
  };

  // Terminal open/close
  const openTerminal = useCallback(() => {
    setTerminalVisible(true);
    Animated.spring(terminalAnim, { toValue: 1, useNativeDriver: false, tension: 80, friction: 10 }).start();
  }, [terminalAnim]);

  const closeTerminal = useCallback(() => {
    Animated.timing(terminalAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start(() => {
      setTerminalVisible(false);
    });
  }, [terminalAnim]);

  // Run code
  const handleRun = useCallback(async () => {
    if (!selectedFileId || !token) return;
    if (isRunningRef.current) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Append a separator if there are existing lines (preserve last output)
    setTerminalLines((prev) =>
      prev.length > 0
        ? [...prev, { id: `sep-${Date.now()}`, type: 'system', text: '──────────────────────────' }]
        : prev
    );
    setExitCode(null);
    isRunningRef.current = true;
    setIsRunning(true);
    openTerminal();

    const TERMINAL_MAX_LINES = 500;
    const addLine = (type: TerminalLine['type'], text: string) => {
      setTerminalLines((prev) => {
        const next = [...prev, { id: `${Date.now()}-${Math.random()}`, type, text }];
        if (next.length > TERMINAL_MAX_LINES) {
          const trimmed = next.slice(next.length - TERMINAL_MAX_LINES);
          // Prepend a faint notice so the user knows output was cleared
          return [
            { id: `trim-${Date.now()}`, type: 'system' as const, text: '— Earlier output cleared —' },
            ...trimmed,
          ];
        }
        return next;
      });
      setTimeout(() => termScrollRef.current?.scrollToEnd({ animated: true }), 50);
    };

    addLine('system', '$ Running...');

    const runStartTime = Date.now();

    try {
      const url = `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/projects/${projectId}/execute`;
      const response = await expoFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fileId: selectedFileId }),
        // @ts-ignore expo fetch streaming
        reactNative: { textStreaming: true },
      });

      if (!response.ok) {
        const err = await response.text();
        addLine('stderr', `Error: ${err}`);
        setIsRunning(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        addLine('stderr', 'Streaming not supported in this environment');
        setIsRunning(false);
        return;
      }

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
                if (event.type === 'stdout') {
                  const stripped = event.payload.replace(/\n$/, '');
                  if (stripped) addLine('stdout', stripped);
                } else if (event.type === 'stderr') {
                  const stripped = event.payload.replace(/\n$/, '');
                  if (stripped) addLine('stderr', stripped);
                } else if (event.type === 'exit') {
                  const code = parseInt(event.payload, 10);
                  setExitCode(code);
                  const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(2);
                  addLine('system', `\nProcess exited with code ${code}  (${elapsed}s)`);
                }
              } catch {
                // skip malformed events
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Execution failed';
      addLine('stderr', msg);
    } finally {
      isRunningRef.current = false;
      setIsRunning(false);
    }
  }, [selectedFileId, token, projectId, openTerminal]);

  // Keep ref always pointing at the latest handleRun so debounce can call it safely
  useEffect(() => { handleRunRef.current = handleRun; }, [handleRun]);

  // Create new file
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
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to create file');
    }
  };

  // Delete file
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
            if (selectedFileId === file.id) {
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
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const sidebarWidth = sidebarAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 160] });

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

        {/* Auto-run toggle */}
        <Pressable
          style={[
            styles.autoRunBtn,
            {
              backgroundColor: autoRun ? colors.primary + '22' : 'transparent',
              borderColor: autoRun ? colors.primary : colors.border,
            },
          ]}
          onPress={() => {
            setAutoRun((v) => !v);
            Haptics.selectionAsync();
          }}
          hitSlop={6}
        >
          <Feather name="zap" size={13} color={autoRun ? colors.primary : colors.mutedForeground} />
          <Text style={[styles.autoRunLabel, { color: autoRun ? colors.primary : colors.mutedForeground }]}>
            Auto
          </Text>
        </Pressable>

        <Pressable
          style={[styles.runBtn, { backgroundColor: isRunning ? colors.muted : colors.primary }]}
          onPress={handleRun}
          disabled={isRunning || !selectedFileId}
        >
          {isRunning ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Ionicons name="play" size={16} color={colors.primaryForeground} />
          )}
        </Pressable>
      </View>

      {/* ── Body: sidebar + editor ────────────────────────────────── */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
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
                  style={[
                    styles.codeInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={editorContent}
                  onChangeText={handleEditorChange}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  textAlignVertical="top"
                  scrollEnabled
                  keyboardType="default"
                  placeholder="// Start coding..."
                  placeholderTextColor={colors.mutedForeground}
                  autoFocus
                  selection={pendingSelection}
                  onSelectionChange={() => setPendingSelection(undefined)}
                  onBlur={() => setIsEditing(false)}
                />
              ) : (
                editorContent.length === 0 ? (
                  <Pressable
                    style={styles.editorPane}
                    onPress={() => {
                      setIsEditing(true);
                      setTimeout(() => codeInputRef.current?.focus(), 50);
                    }}
                  >
                    <Text style={[styles.codeInput, { color: colors.mutedForeground }]}>
                      // Start coding...
                    </Text>
                  </Pressable>
                ) : (
                  <SyntaxHighlighter
                    code={editorContent}
                    language={selectedFile.language}
                    onLinePress={(lineIndex) => {
                      // Compute char offset of the start of the tapped line
                      const codeLines = editorContent.split('\n');
                      const charOffset = codeLines
                        .slice(0, lineIndex)
                        .reduce((sum, l) => sum + l.length + 1, 0);
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
                <Text style={[styles.noFileText, { color: colors.mutedForeground }]}>
                  Select a file to edit
                </Text>
              </View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* ── Terminal Panel ────────────────────────────────────────── */}
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
          {/* Terminal header */}
          <View style={[styles.termHeader, { borderBottomColor: colors.border }]}>
            <View style={styles.termHeaderLeft}>
              <View style={[styles.termDot, { backgroundColor: '#f85149' }]} />
              <View style={[styles.termDot, { backgroundColor: '#d29922' }]} />
              <View style={[styles.termDot, { backgroundColor: '#3fb950' }]} />
              <Text style={[styles.termTitle, { color: '#8b949e' }]}>Terminal</Text>
            </View>
            <View style={styles.termHeaderRight}>
              {exitCode !== null && (
                <View style={[styles.exitBadge, { backgroundColor: exitCode === 0 ? '#3fb95022' : '#f8514922', borderColor: exitCode === 0 ? '#3fb95055' : '#f8514955' }]}>
                  <Text style={[styles.exitText, { color: exitCode === 0 ? '#3fb950' : '#f85149' }]}>
                    exit {exitCode}
                  </Text>
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

          {/* Terminal output */}
          <ScrollView
            ref={termScrollRef}
            style={styles.termOutput}
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
        </Animated.View>
      )}

      {/* Show terminal button when hidden */}
      {!terminalVisible && (
        <Pressable
          style={[styles.termToggle, { backgroundColor: colors.card, borderTopColor: colors.border }]}
          onPress={openTerminal}
        >
          <Text style={[styles.termToggleText, { color: colors.mutedForeground }]}>Terminal</Text>
          <Ionicons name="chevron-up" size={16} color={colors.mutedForeground} />
        </Pressable>
      )}

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
            <View style={styles.langRow}>
              {(['javascript', 'python', 'plaintext'] as const).map((lang) => (
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
                    {lang === 'javascript' ? 'JS' : lang === 'python' ? 'PY' : 'TXT'}
                  </Text>
                </Pressable>
              ))}
            </View>
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
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    gap: 8,
  },
  headerBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  headerTitle: { flex: 1, minWidth: 0 },
  projectName: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  fileName: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  saveIndicator: { marginRight: 4 },
  autoRunBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  autoRunLabel: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  runBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, flexDirection: 'row', overflow: 'hidden' },
  sidebar: {
    overflow: 'hidden',
    borderRightWidth: 1,
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  sidebarTitle: { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 1 },
  fileList: { flex: 1 },
  noFiles: { fontSize: 11, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 16 },
  editorPane: { flex: 1 },
  codeInput: {
    flex: 1,
    padding: 14,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  noFileSelected: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  noFileText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  terminal: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    overflow: 'hidden',
  },
  termHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  termHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  termDot: { width: 10, height: 10, borderRadius: 5 },
  termTitle: { fontSize: 11, fontFamily: 'Inter_500Medium', marginLeft: 8, letterSpacing: 0.5 },
  termHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  exitBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  exitText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  termBtn: { padding: 2 },
  termOutput: { flex: 1 },
  termLine: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  termToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 6,
    borderTopWidth: 1,
  },
  termToggleText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  modalBox: { width: 300, borderRadius: 16, borderWidth: 1, padding: 20, gap: 10 },
  modalTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  modalInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  langLabel: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  langRow: { flexDirection: 'row', gap: 6 },
  langChip: { flex: 1, paddingVertical: 7, borderRadius: 6, borderWidth: 1, alignItems: 'center' },
  langChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  modalActions: { flexDirection: 'row', gap: 8 },
  modalBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  modalBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});
