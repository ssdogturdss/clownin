import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  Modal,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCreateProject,
  getListProjectsQueryKey,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useProfile } from '@/hooks/useProfile';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Template {
  id: string;
  name: string;
  description: string;
  language: string;
  icon: string;
  keywords?: string[];
}

// ── Language tab labels ────────────────────────────────────────────────────────
const LANG_TAB_LABELS: Record<string, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'Python',
  bash: 'Bash',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  java: 'Java',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getApiBase(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `https://${window.location.hostname.replace('.expo.kirk.replit.dev', '.kirk.replit.dev')}`;
  }
  return `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ''}`;
}

const LANG_COLORS: Record<string, string> = {
  javascript: '#f7df1e',
  typescript: '#3178c6',
  python: '#3572A5',
  bash: '#4eaa25',
  go: '#00ADD8',
  rust: '#CE422B',
  ruby: '#CC342D',
  java: '#ED8B00',
  plaintext: '#8b949e',
};

const LANG_LABELS: Record<string, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  bash: 'SH',
  go: 'GO',
  rust: 'RS',
  ruby: 'RB',
  java: 'JV',
};

// ── Data hook ─────────────────────────────────────────────────────────────────
function useTemplates() {
  return useQuery<Template[]>({
    queryKey: ['templates'],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/templates`);
      if (!res.ok) throw new Error('Failed to load templates');
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // templates rarely change
  });
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function TemplatesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const assistMode = mode === 'assist';

  const { data: templates, isLoading, isError, refetch } = useTemplates();
  const createMutation = useCreateProject();

  const [selected, setSelected] = useState<Template | null>(null);
  const [projectName, setProjectName] = useState('');
  const [showNaming, setShowNaming] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeLanguage, setActiveLanguage] = useState<string | null>(null);

  const filteredTemplates = useMemo(() => {
    if (!templates) return [];
    const q = searchQuery.trim().toLowerCase();
    return templates.filter((t) => {
      const matchesLang = activeLanguage === null || t.language === activeLanguage;
      const matchesSearch =
        q === '' ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q);
      return matchesLang && matchesSearch;
    });
  }, [templates, searchQuery, activeLanguage]);

  // Build tabs dynamically from available template languages only
  const languageTabs = useMemo(() => {
    if (!templates) return [];
    const seen = new Set<string>();
    const langs: string[] = [];
    for (const t of templates) {
      if (!seen.has(t.language)) {
        seen.add(t.language);
        langs.push(t.language);
      }
    }
    return langs;
  }, [templates]);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const handleSelectTemplate = useCallback(
    (template: Template) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (assistMode) {
        router.replace({ pathname: '/(app)', params: { assistTemplateId: template.id } });
        return;
      }
      setSelected(template);
      setProjectName(template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      setShowNaming(true);
    },
    [assistMode]
  );

  const handleCreate = useCallback(async () => {
    if (!selected || !projectName.trim()) return;

    // Proactive free-tier project limit check (mirrors index.tsx logic)
    // We don't import useListProjects here — the paywall will surface from the API 402.

    try {
      const project = await createMutation.mutateAsync({
        data: {
          name: projectName.trim(),
          language: selected.language,
          templateId: selected.id,
        },
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      setShowNaming(false);
      router.replace({
        pathname: '/(app)/project/[id]',
        params: { id: String(project.id) },
      });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 402) {
        Alert.alert('Limit reached', 'You have reached the free plan project limit. Upgrade to create more projects.');
      } else {
        Alert.alert('Error', 'Failed to create project. Please try again.');
      }
    }
  }, [selected, projectName, createMutation, queryClient]);

  const renderTemplate = useCallback(
    ({ item }: { item: Template }) => {
      const langColor = LANG_COLORS[item.language] ?? '#8b949e';
      const langLabel = LANG_LABELS[item.language] ?? item.language.slice(0, 2).toUpperCase();
      return (
        <Pressable
          style={({ pressed }) => [
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
            pressed && { opacity: 0.75 },
          ]}
          onPress={() => handleSelectTemplate(item)}
        >
          <View style={[styles.iconWrap, { backgroundColor: langColor + '18' }]}>
            <MaterialCommunityIcons
              name={item.icon as any}
              size={28}
              color={langColor}
            />
          </View>
          <Text style={[styles.cardName, { color: colors.foreground }]} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={[styles.cardDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
            {item.description}
          </Text>
          <View style={[styles.langBadge, { backgroundColor: langColor + '22', borderColor: langColor + '55' }]}>
            <Text style={[styles.langBadgeText, { color: langColor }]}>{langLabel}</Text>
          </View>
        </Pressable>
      );
    },
    [colors, handleSelectTemplate]
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: topPad + 12, borderBottomColor: colors.border },
        ]}
      >
        <Pressable
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Templates
          </Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {assistMode ? 'Choose a starting point for Assist' : 'Start with a working project'}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {/* Search + Filter */}
      {!isLoading && !isError && (
        <>
          {/* Search bar */}
          <View style={[styles.searchWrap, { borderBottomColor: colors.border }]}>
            <View style={[styles.searchBox, { backgroundColor: colors.input ?? colors.secondary, borderColor: colors.border }]}>
              <Ionicons name="search" size={16} color={colors.mutedForeground} style={{ marginRight: 6 }} />
              <TextInput
                style={[styles.searchInput, { color: colors.foreground }]}
                placeholder="Search templates…"
                placeholderTextColor={colors.mutedForeground}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                clearButtonMode="while-editing"
              />
            </View>
          </View>

          {/* Language filter tabs */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabsContent}
            style={[styles.tabsRow, { borderBottomColor: colors.border }]}
          >
            {/* "All" tab */}
            {(() => {
              const isActive = activeLanguage === null;
              return (
                <Pressable
                  key="all"
                  style={[
                    styles.tab,
                    isActive
                      ? { backgroundColor: colors.primary, borderColor: colors.primary }
                      : { backgroundColor: 'transparent', borderColor: colors.border },
                  ]}
                  onPress={() => setActiveLanguage(null)}
                >
                  <Text style={[styles.tabText, { color: isActive ? colors.primaryForeground : colors.mutedForeground }]}>
                    All
                  </Text>
                </Pressable>
              );
            })()}
            {/* One tab per language actually present in the fetched templates */}
            {languageTabs.map((lang) => {
              const isActive = activeLanguage === lang;
              const label = LANG_TAB_LABELS[lang] ?? lang.slice(0, 2).toUpperCase();
              return (
                <Pressable
                  key={lang}
                  style={[
                    styles.tab,
                    isActive
                      ? { backgroundColor: colors.primary, borderColor: colors.primary }
                      : { backgroundColor: 'transparent', borderColor: colors.border },
                  ]}
                  onPress={() => setActiveLanguage(lang)}
                >
                  <Text style={[styles.tabText, { color: isActive ? colors.primaryForeground : colors.mutedForeground }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}

      {/* Content */}
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
            Failed to load templates
          </Text>
          <Pressable
            style={[styles.retryBtn, { borderColor: colors.border }]}
            onPress={() => refetch()}
          >
            <Text style={[styles.retryText, { color: colors.foreground }]}>Retry</Text>
          </Pressable>
        </View>
      ) : filteredTemplates.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="search-outline" size={48} color={colors.mutedForeground} />
          <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
            No templates match your search
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredTemplates}
          keyExtractor={(item) => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.grid,
            { paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 24 },
          ]}
          renderItem={renderTemplate}
        />
      )}

      {/* Naming Modal */}
      <Modal
        visible={showNaming}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNaming(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowNaming(false)}
        >
          <Pressable
            style={[
              styles.modalBox,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            {selected && (
              <>
                <View style={styles.modalHeader}>
                  <MaterialCommunityIcons
                    name={selected.icon as any}
                    size={24}
                    color={LANG_COLORS[selected.language] ?? colors.primary}
                  />
                  <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                    {selected.name}
                  </Text>
                </View>
                <Text style={[styles.modalSub, { color: colors.mutedForeground }]}>
                  {selected.description}
                </Text>
              </>
            )}

            <Text style={[styles.inputLabel, { color: colors.mutedForeground }]}>
              Project name
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  borderColor: colors.border,
                  backgroundColor: colors.input ?? colors.secondary,
                },
              ]}
              placeholder="my-project"
              placeholderTextColor={colors.mutedForeground}
              value={projectName}
              onChangeText={setProjectName}
              autoFocus
              returnKeyType="done"
              autoCapitalize="none"
              onSubmitEditing={handleCreate}
            />

            <View style={styles.modalActions}>
              <Pressable
                style={[styles.modalBtn, { borderColor: colors.border }]}
                onPress={() => setShowNaming(false)}
              >
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  { backgroundColor: colors.primary },
                ]}
                onPress={handleCreate}
                disabled={createMutation.isPending || !projectName.trim()}
              >
                {createMutation.isPending ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>
                    Create
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 36, height: 36, justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold' },
  headerSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorText: { fontSize: 15, fontFamily: 'Inter_400Regular' },
  retryBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
    marginTop: 4,
  },
  retryText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  grid: { padding: 12 },
  row: { gap: 12 },
  card: {
    flex: 1,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 12,
    gap: 6,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  cardName: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  cardDesc: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 16 },
  langBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    marginTop: 4,
  },
  langBadgeText: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
  // Search
  searchWrap: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  // Tabs
  tabsRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabsContent: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  tabText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalBox: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 12,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modalTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold' },
  modalSub: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
  inputLabel: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
  },
  modalBtnPrimary: { borderWidth: 0 },
  modalBtnText: { fontSize: 15, fontFamily: 'Inter_500Medium' },
});
