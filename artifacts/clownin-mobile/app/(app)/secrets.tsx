/**
 * Secrets vault screen.
 *
 * Users store named secrets (API keys, tokens, passwords) here once.
 * Values are write-only and encrypted at rest.  From the project environment
 * screen, users can inject any vault secret into a project in one tap.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useListSecrets, useUpsertSecret, useDeleteSecret } from '@workspace/api-client-react';

export default function SecretsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const { data, isLoading, refetch } = useListSecrets();
  const upsertMutation = useUpsertSecret();
  const deleteMutation = useDeleteSecret();

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [nameError, setNameError] = useState('');

  const secrets = data?.secrets ?? [];

  const resetForm = () => {
    setNewName('');
    setNewValue('');
    setNewDesc('');
    setNameError('');
    setEditingId(null);
    setShowAdd(false);
  };

  const handleSave = useCallback(async () => {
    const n = newName.trim().toUpperCase();
    if (!n) { setNameError('Name is required'); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
      setNameError('Letters, digits, underscores only; cannot start with a digit');
      return;
    }
    if (!newValue && editingId === null) {
      setNameError('');
      Alert.alert('Value required', 'Enter a value for the secret.');
      return;
    }
    setNameError('');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    upsertMutation.mutate(
      { data: { name: n, value: newValue, description: newDesc || undefined } },
      {
        onSuccess: () => {
          resetForm();
          refetch();
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Failed to save';
          Alert.alert('Error', msg);
        },
      },
    );
  }, [newName, newValue, newDesc, editingId, upsertMutation, refetch]);

  const handleDelete = useCallback((id: number, name: string) => {
    Alert.alert(
      'Delete secret',
      `Remove "${name}"? Any project env vars that reference it will keep their current value.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            deleteMutation.mutate(
              { id },
              { onSuccess: () => refetch() },
            );
          },
        },
      ],
    );
  }, [deleteMutation, refetch]);

  const startEdit = (id: number, name: string, description: string | null) => {
    setEditingId(id);
    setNewName(name);
    setNewValue('');
    setNewDesc(description ?? '');
    setNameError('');
    setShowAdd(true);
  };

  const s = createStyles(colors, insets);

  return (
    <KeyboardAvoidingView
      style={[s.root, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 8, borderBottomColor: colors.border, backgroundColor: colors.card }]}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={colors.foreground} />
        </Pressable>
        <View style={s.headerCenter}>
          <MaterialCommunityIcons name="shield-lock-outline" size={18} color={colors.primary} />
          <Text style={[s.title, { color: colors.foreground }]}>Secrets vault</Text>
        </View>
        <Pressable
          style={[s.addBtn, { backgroundColor: colors.primary }]}
          onPress={() => { resetForm(); setShowAdd(true); }}
          hitSlop={4}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={s.addBtnText}>New</Text>
        </Pressable>
      </View>

      {/* Info banner */}
      {!showAdd && (
        <View style={[s.banner, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <Ionicons name="information-circle-outline" size={14} color={colors.mutedForeground} style={{ marginTop: 1 }} />
          <Text style={[s.bannerText, { color: colors.mutedForeground }]}>
            Store API keys and tokens once. Inject them into any project's environment in one tap.
          </Text>
        </View>
      )}

      {/* Add / Edit form */}
      {showAdd && (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={[s.addForm, { backgroundColor: colors.card, borderBottomColor: colors.border }]}
          contentContainerStyle={{ gap: 6, padding: 16 }}
        >
          <Text style={[s.addFormTitle, { color: colors.foreground }]}>
            {editingId !== null ? 'Update secret' : 'New secret'}
          </Text>
          <Text style={[s.addFormHint, { color: colors.mutedForeground }]}>
            Values are write-only and encrypted at rest. They are never shown after saving.
          </Text>

          <Text style={[s.label, { color: colors.mutedForeground }]}>Name</Text>
          <TextInput
            style={[s.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: nameError ? '#f85149' : colors.border }]}
            placeholder="OPENAI_API_KEY"
            placeholderTextColor={colors.mutedForeground}
            value={newName}
            onChangeText={(t) => { setNewName(t.toUpperCase()); setNameError(''); }}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus={editingId === null}
            editable={editingId === null}
          />
          {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

          <Text style={[s.label, { color: colors.mutedForeground }]}>
            Value{editingId !== null ? ' (leave blank to keep existing)' : ''}
          </Text>
          <TextInput
            style={[s.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            placeholder="sk-…"
            placeholderTextColor={colors.mutedForeground}
            value={newValue}
            onChangeText={setNewValue}
            autoCorrect={false}
            autoCapitalize="none"
            secureTextEntry
            autoFocus={editingId !== null}
          />

          <Text style={[s.label, { color: colors.mutedForeground }]}>Description (optional)</Text>
          <TextInput
            style={[s.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            placeholder="e.g. Production OpenAI key"
            placeholderTextColor={colors.mutedForeground}
            value={newDesc}
            onChangeText={setNewDesc}
            autoCorrect={false}
          />

          <View style={s.addFormActions}>
            <Pressable style={[s.cancelBtn, { borderColor: colors.border }]} onPress={resetForm}>
              <Text style={[s.cancelBtnText, { color: colors.mutedForeground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[s.saveBtn, { backgroundColor: colors.primary, opacity: upsertMutation.isPending ? 0.6 : 1 }]}
              onPress={handleSave}
              disabled={upsertMutation.isPending}
            >
              {upsertMutation.isPending
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={s.saveBtnText}>Save</Text>}
            </Pressable>
          </View>
        </ScrollView>
      )}

      {/* List */}
      {isLoading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : secrets.length === 0 && !showAdd ? (
        <View style={s.center}>
          <MaterialCommunityIcons name="shield-lock-outline" size={44} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
          <Text style={[s.emptyTitle, { color: colors.foreground }]}>No secrets yet</Text>
          <Text style={[s.emptyHint, { color: colors.mutedForeground }]}>
            Add API keys, tokens, and passwords here.{'\n'}
            Inject them into any project in one tap.
          </Text>
          <Pressable
            style={[s.emptyBtn, { backgroundColor: colors.primary, marginTop: 20 }]}
            onPress={() => { resetForm(); setShowAdd(true); }}
          >
            <Ionicons name="add" size={16} color="#fff" />
            <Text style={s.addBtnText}>Add your first secret</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={secrets}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          ItemSeparatorComponent={() => <View style={[s.separator, { backgroundColor: colors.border }]} />}
          renderItem={({ item }) => (
            <View style={[s.row, { backgroundColor: colors.card }]}>
              <MaterialCommunityIcons name="shield-key-outline" size={18} color={colors.primary} style={{ marginRight: 12 }} />
              <View style={s.rowBody}>
                <Text style={[s.keyText, { color: colors.foreground }]}>{item.name}</Text>
                {item.description ? (
                  <Text style={[s.descText, { color: colors.mutedForeground }]}>{item.description}</Text>
                ) : (
                  <Text style={[s.maskedText, { color: colors.mutedForeground }]}>••••••••••••</Text>
                )}
              </View>
              <View style={s.rowActions}>
                <Pressable
                  style={[s.iconBtn, { backgroundColor: colors.primary + '22' }]}
                  onPress={() => startEdit(item.id, item.name, item.description ?? null)}
                  hitSlop={8}
                >
                  <Ionicons name="pencil-outline" size={15} color={colors.primary} />
                </Pressable>
                <Pressable
                  style={[s.iconBtn, { backgroundColor: '#f8514922' }]}
                  onPress={() => handleDelete(item.id, item.name)}
                  hitSlop={8}
                >
                  <Ionicons name="trash-outline" size={15} color="#f85149" />
                </Pressable>
              </View>
            </View>
          )}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ReturnType<typeof useColors>, insets: ReturnType<typeof useSafeAreaInsets>) {
  return StyleSheet.create({
    root: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      gap: 8,
    },
    backBtn: { padding: 4 },
    headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
    title: { fontSize: 17, fontWeight: '600' },
    addBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
    },
    addBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    banner: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    bannerText: { flex: 1, fontSize: 12, lineHeight: 17 },
    addForm: { borderBottomWidth: StyleSheet.hairlineWidth, maxHeight: 480 },
    addFormTitle: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
    addFormHint: { fontSize: 12, lineHeight: 16, marginBottom: 4 },
    label: { fontSize: 12, fontWeight: '500', marginTop: 4 },
    input: {
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    errorText: { color: '#f85149', fontSize: 12 },
    addFormActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
    cancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
    cancelBtnText: { fontSize: 14, fontWeight: '500' },
    saveBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 8 },
    saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 8, textAlign: 'center' },
    emptyHint: { fontSize: 13, textAlign: 'center', lineHeight: 19, color: '#888' },
    emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingVertical: 11, borderRadius: 10 },
    separator: { height: StyleSheet.hairlineWidth },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    rowBody: { flex: 1 },
    keyText: { fontSize: 14, fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    descText: { fontSize: 12, marginTop: 2, lineHeight: 16 },
    maskedText: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 2 },
    rowActions: { flexDirection: 'row', gap: 8 },
    iconBtn: { padding: 7, borderRadius: 7 },
  });
}
