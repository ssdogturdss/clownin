import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Platform,
  RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import {
  useListProjects,
  useCreateProject,
  useDeleteProject,
  useUpdateProject,
  getListProjectsQueryKey,
} from '@workspace/api-client-react';
import type { Project } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OnboardingScreen } from '@/components/OnboardingScreen';
import { PaywallSheet, type PaywallReason } from '@/components/PaywallSheet';
import { ProfileModal } from '@/components/ProfileModal';
import { useProfile, PROFILE_QUERY_KEY } from '@/hooks/useProfile';

// ── Idea → language detection ─────────────────────────────────────────────────
function detectLanguage(idea: string): 'javascript' | 'typescript' | 'python' | 'bash' {
  const lower = idea.toLowerCase();
  const pythonKw = ['python', 'flask', 'django', 'fastapi', 'scraper', 'scraping', 'pandas', 'numpy', 'data science', 'machine learning', 'ml ', 'matplotlib', 'pip ', 'requests '];
  const tsKw = ['typescript', 'react', 'next.js', 'nextjs', 'angular', 'vue'];
  if (pythonKw.some((k) => lower.includes(k))) return 'python';
  if (tsKw.some((k) => lower.includes(k))) return 'typescript';
  return 'javascript';
}

// ── Idea → project name ───────────────────────────────────────────────────────
function deriveProjectName(idea: string): string {
  const cleaned = idea
    .toLowerCase()
    .replace(/^(build|create|make|write|generate|a |an |the )+/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-');
  return cleaned.slice(0, 40) || 'my-project';
}

const LANG_COLORS: Record<string, string> = {
  javascript: '#f7df1e',
  typescript: '#3178c6',
  python: '#3572A5',
  bash: '#4eaa25',
  plaintext: '#8b949e',
};

const LANG_LABELS: Record<string, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  bash: 'SH',
};

function LangBadge({ language }: { language: string }) {
  const color = LANG_COLORS[language] ?? '#8b949e';
  const label = LANG_LABELS[language] ?? language.slice(0, 2).toUpperCase();
  return (
    <View style={[badgeStyles.badge, { backgroundColor: color + '22', borderColor: color + '55' }]}>
      <Text style={[badgeStyles.text, { color }]}>{label}</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  text: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
});

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ProjectsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();

  const { data: projects, isLoading, isError, refetch } = useListProjects();
  const createMutation = useCreateProject();
  const deleteMutation = useDeleteProject();
  const updateMutation = useUpdateProject();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLang, setNewLang] = useState<'javascript' | 'typescript' | 'python' | 'bash'>('javascript');
  const [refreshing, setRefreshing] = useState(false);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
  const [renameName, setRenameName] = useState('');
  const [onboardingSkipped, setOnboardingSkipped] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallReason, setPaywallReason] = useState<PaywallReason>('project_limit');
  const [showProfile, setShowProfile] = useState(false);

  const { data: profile } = useProfile();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    // Proactive project limit check
    if (profile?.subscriptionTier === 'free' && (projects?.length ?? 0) >= 3) {
      setPaywallReason('project_limit');
      setShowPaywall(true);
      setShowCreate(false);
      return;
    }
    try {
      await createMutation.mutateAsync({ data: { name: newName.trim(), language: newLang } });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      setShowCreate(false);
      setNewName('');
    } catch (err: unknown) {
      if ((err as any)?.status === 402) {
        const code = (err as any)?.data?.code;
        setPaywallReason(code === 'project_limit_exceeded' ? 'project_limit' : 'daily_limit');
        setShowPaywall(true);
        setShowCreate(false);
      } else {
        Alert.alert('Error', 'Failed to create project');
      }
    }
  };

  const handleRename = async () => {
    if (!renameProject || !renameName.trim()) return;
    try {
      await updateMutation.mutateAsync({ id: renameProject.id, data: { name: renameName.trim() } });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      setRenameProject(null);
    } catch {
      Alert.alert('Error', 'Failed to rename project');
    }
  };

  const handleDelete = (project: Project) => {
    Alert.alert(
      'Delete Project',
      `Delete "${project.name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync({ id: project.id });
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
              // Clean up all AsyncStorage keys for this project
              try {
                const allKeys = await AsyncStorage.getAllKeys();
                const prefix = `scroll_${project.id}_`;
                const staleKeys = allKeys.filter((k) => k.startsWith(prefix));
                staleKeys.push(`selected_file_${project.id}`);
                staleKeys.push(`terminal_open_${project.id}`);
                if (staleKeys.length > 0) {
                  await AsyncStorage.multiRemove(staleKeys);
                }
              } catch {
                // cleanup failure is non-critical
              }
            } catch {
              Alert.alert('Error', 'Failed to delete project');
            }
          },
        },
      ],
    );
  };

  const handleLogout = useCallback(async () => {
    await logout();
    router.replace('/(auth)/login');
  }, [logout]);

  const handleIdeaSubmit = useCallback(async (idea: string) => {
    if (profile?.subscriptionTier === 'free' && (projects?.length ?? 0) >= 3) {
      setPaywallReason('project_limit');
      setShowPaywall(true);
      return;
    }
    const language = detectLanguage(idea);
    const name = deriveProjectName(idea);
    try {
      const project = await createMutation.mutateAsync({ data: { name, language } });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      router.push({
        pathname: '/(app)/project/[id]',
        params: { id: String(project.id), initialMessage: idea },
      });
    } catch (err: unknown) {
      if ((err as any)?.status === 402) {
        const code = (err as any)?.data?.code;
        setPaywallReason(code === 'project_limit_exceeded' ? 'project_limit' : 'daily_limit');
        setShowPaywall(true);
      } else {
        Alert.alert('Error', 'Could not create project. Please try again.');
      }
    }
  }, [createMutation, queryClient, profile, projects]);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  // Show onboarding to first-time users who have no projects yet
  if (!isLoading && !isError && projects?.length === 0 && !onboardingSkipped) {
    return (
      <OnboardingScreen
        onSubmit={handleIdeaSubmit}
        onSkip={() => setOnboardingSkipped(true)}
        isLoading={createMutation.isPending}
      />
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            clownin
          </Text>
          {user && (
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
              @{user.username}
            </Text>
          )}
        </View>
        <View style={styles.headerActions}>
          <Pressable
            style={[styles.iconBtn, { backgroundColor: colors.primary }]}
            onPress={() => { setShowCreate(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
          >
            <Ionicons name="add" size={22} color={colors.primaryForeground} />
          </Pressable>
          <Pressable
            style={styles.iconBtn}
            onPress={() => { setShowProfile(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
          >
            <Ionicons name="person-circle-outline" size={26} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </View>

      {/* Content */}
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.destructive} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Failed to load projects</Text>
          <Pressable style={[styles.retryBtn, { borderColor: colors.border }]} onPress={() => refetch()}>
            <Text style={[styles.retryText, { color: colors.foreground }]}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(item) => String(item.id)}
          scrollEnabled={!!(projects && projects.length > 0)}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          contentContainerStyle={[
            styles.list,
            { paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 20 },
          ]}
          ListEmptyComponent={
            <View style={styles.centered}>
              <MaterialCommunityIcons name="code-braces" size={56} color={colors.border} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No projects yet</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                Tap + to create your first project
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.projectCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {/* Header row: folder + name + badge + delete — all siblings at the same level */}
              <View style={styles.cardTop}>
                <Pressable
                  style={({ pressed }) => [styles.cardLeft, pressed && styles.cardPressed]}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    router.push(`/(app)/project/${item.id}`);
                  }}
                  onLongPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setRenameProject(item);
                    setRenameName(item.name);
                  }}
                >
                  <MaterialCommunityIcons
                    name="folder-outline"
                    size={18}
                    color={colors.primary}
                    style={styles.folderIcon}
                  />
                  <Text style={[styles.projectName, { color: colors.foreground }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                </Pressable>
                <LangBadge language={item.language} />
                <Pressable
                  style={styles.cardDeleteBtn}
                  onPress={() => handleDelete(item)}
                  hitSlop={8}
                >
                  <Ionicons name="trash-outline" size={16} color={colors.destructive} />
                </Pressable>
              </View>
              {/* Tapping the date row also opens the project */}
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push(`/(app)/project/${item.id}`);
                }}
              >
                <View style={styles.cardBottom}>
                  <Text style={[styles.dateText, { color: colors.mutedForeground }]}>
                    Updated {formatDate(item.updatedAt)}
                  </Text>
                </View>
              </Pressable>
            </View>
          )}
        />
      )}

      {/* Rename Project Modal */}
      <Modal visible={!!renameProject} transparent animationType="fade" onRequestClose={() => setRenameProject(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setRenameProject(null)}>
          <Pressable style={[styles.modalBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Rename Project</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
              placeholder="Project name"
              placeholderTextColor={colors.mutedForeground}
              value={renameName}
              onChangeText={setRenameName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleRename}
            />
            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, { borderColor: colors.border }]} onPress={() => setRenameProject(null)}>
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnPrimary, { backgroundColor: colors.primary }]}
                onPress={handleRename}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>Rename</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Paywall */}
      <PaywallSheet
        visible={showPaywall}
        onClose={() => setShowPaywall(false)}
        reason={paywallReason}
      />

      {/* Profile */}
      <ProfileModal
        visible={showProfile}
        onClose={() => setShowProfile(false)}
        onLogout={handleLogout}
      />

      {/* Create Project Modal */}
      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={() => setShowCreate(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowCreate(false)}>
          <Pressable style={[styles.modalBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>New Project</Text>

            <TextInput
              style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
              placeholder="Project name"
              placeholderTextColor={colors.mutedForeground}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleCreate}
            />

            <Text style={[styles.langLabel, { color: colors.mutedForeground }]}>Language</Text>
            <View style={styles.langRow}>
              {([
                { id: 'javascript', label: 'JS' },
                { id: 'typescript', label: 'TS' },
                { id: 'python', label: 'PY' },
                { id: 'bash', label: 'SH' },
              ] as const).map(({ id, label }) => (
                <Pressable
                  key={id}
                  style={[
                    styles.langChip,
                    {
                      backgroundColor: newLang === id ? colors.primary : colors.secondary,
                      borderColor: newLang === id ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => setNewLang(id)}
                >
                  <Text
                    style={[
                      styles.langChipText,
                      { color: newLang === id ? colors.primaryForeground : colors.foreground },
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.modalActions}>
              <Pressable style={[styles.modalBtn, { borderColor: colors.border }]} onPress={() => setShowCreate(false)}>
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnPrimary, { backgroundColor: colors.primary }]}
                onPress={handleCreate}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>Create</Text>
                )}
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
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 28, fontFamily: 'Inter_700Bold', letterSpacing: -0.5 },
  headerSub: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
  headerActions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, minHeight: 300 },
  emptyTitle: { fontSize: 18, fontFamily: 'Inter_600SemiBold', marginTop: 16 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', marginTop: 6, textAlign: 'center' },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  retryText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  list: { padding: 16, gap: 10 },
  projectCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  cardPressed: { opacity: 0.8 },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  cardLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  folderIcon: { marginRight: 8 },
  projectName: { fontSize: 16, fontFamily: 'Inter_600SemiBold', flex: 1 },
  cardBottom: { flexDirection: 'row', alignItems: 'center' },
  dateText: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  cardDeleteBtn: { padding: 6 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  modalBox: { width: 320, borderRadius: 16, borderWidth: 1, padding: 24, gap: 12 },
  modalTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  modalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  langLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', marginTop: 4 },
  langRow: { flexDirection: 'row', gap: 8 },
  langChip: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  langChipText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  modalBtnPrimary: { borderWidth: 0 },
  modalBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
