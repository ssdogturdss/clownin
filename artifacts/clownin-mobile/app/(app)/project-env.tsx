/**
 * Per-project environment variables screen.
 *
 * Lets users add, view (masked), and delete key=value pairs that are injected
 * into every code run for the project. Values are write-only: they are never
 * returned from the API after saving.
 *
 * Includes "From vault" — pick a saved secret and inject it in one tap.
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
  Modal,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { fetch as expoFetch } from 'expo/fetch';
import { useListSecrets, useInjectSecretIntoEnv } from '@workspace/api-client-react';

type EnvVar = { key: string; maskedValue: string };

function getApiHost(): string {
  const domain = process.env.EXPO_PUBLIC_API_URL ?? '';
  if (domain) return domain;
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const h = window.location.hostname.replace('.expo', '');
    return `https://${h}`;
  }
  return '';
}

export default function ProjectEnvScreen() {
  const { projectId: rawId } = useLocalSearchParams();
  const projectId = parseInt(String(rawId), 10);
  const { token } = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Add form state
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [keyError, setKeyError] = useState('');

  // Vault picker state
  const [showVaultPicker, setShowVaultPicker] = useState(false);

  const apiBase = getApiHost();

  // Vault secrets
  const { data: vaultData, isLoading: vaultLoading } = useListSecrets();
  const injectMutation = useInjectSecretIntoEnv();

  const fetchVars = useCallback(async () => {
    try {
      const res = await expoFetch(`${apiBase}/api/projects/${projectId}/env`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { vars: EnvVar[] };
        setVars(data.vars ?? []);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [apiBase, projectId, token]);

  useEffect(() => { fetchVars(); }, [fetchVars]);

  const handleAdd = useCallback(async () => {
    const k = newKey.trim();
    const v = newValue;

    if (!k) { setKeyError('Key is required'); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      setKeyError('Must start with a letter or underscore, then letters/digits/underscores');
      return;
    }
    setKeyError('');
    setSaving(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      const res = await expoFetch(`${apiBase}/api/projects/${projectId}/env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: k, value: v }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        Alert.alert('Error', data.error ?? 'Failed to save');
        return;
      }
      setNewKey('');
      setNewValue('');
      setShowAdd(false);
      await fetchVars();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }, [apiBase, projectId, token, newKey, newValue, fetchVars]);

  const handleDelete = useCallback((key: string) => {
    Alert.alert(
      'Delete variable',
      `Remove ${key}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            try {
              await expoFetch(
                `${apiBase}/api/projects/${projectId}/env/${encodeURIComponent(key)}`,
                { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
              );
              setVars((prev) => prev.filter((v) => v.key !== key));
            } catch (err: unknown) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Network error');
            }
          },
        },
      ],
    );
  }, [apiBase, projectId, token]);

  const handleInjectFromVault = useCallback((secretId: number, secretName: string) => {
    setShowVaultPicker(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    injectMutation.mutate(
      { id: projectId, secretId },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          fetchVars();
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? 'Failed to inject secret';
          Alert.alert('Error', msg);
        },
      },
    );
  }, [projectId, injectMutation, fetchVars]);

  const topPad = insets.top;
  const bottomPad = insets.bottom;

  const vaultSecrets = vaultData?.secrets ?? [];

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 8, borderBottomColor: colors.border, backgroundColor: colors.card }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Environment</Text>
        <Pressable
          style={[styles.vaultBtn, { borderColor: colors.border }]}
          onPress={() => { setShowAdd(false); setShowVaultPicker(true); }}
          hitSlop={4}
        >
          <MaterialCommunityIcons name="shield-key-outline" size={15} color={colors.foreground} />
          <Text style={[styles.vaultBtnText, { color: colors.foreground }]}>Vault</Text>
        </Pressable>
        <Pressable
          style={[styles.addBtn, { backgroundColor: colors.primary }]}
          onPress={() => { setShowVaultPicker(false); setShowAdd(true); setNewKey(''); setNewValue(''); setKeyError(''); }}
          hitSlop={4}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {/* Add form */}
      {showAdd && (
        <View style={[styles.addForm, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <Text style={[styles.addFormTitle, { color: colors.foreground }]}>New variable</Text>
          <Text style={[styles.addFormHint, { color: colors.mutedForeground }]}>
            Values are write-only — they'll be injected into your runs but won't be shown again.
          </Text>

          <Text style={[styles.label, { color: colors.mutedForeground }]}>Key</Text>
          <TextInput
            style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: keyError ? '#f85149' : colors.border }]}
            placeholder="API_KEY"
            placeholderTextColor={colors.mutedForeground}
            value={newKey}
            onChangeText={(t) => { setNewKey(t); setKeyError(''); }}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
          />
          {!!keyError && <Text style={styles.errorText}>{keyError}</Text>}

          <Text style={[styles.label, { color: colors.mutedForeground }]}>Value</Text>
          <TextInput
            style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            placeholder="sk_live_…"
            placeholderTextColor={colors.mutedForeground}
            value={newValue}
            onChangeText={setNewValue}
            autoCorrect={false}
            autoCapitalize="none"
            secureTextEntry
          />

          <View style={styles.addFormActions}>
            <Pressable
              style={[styles.cancelBtn, { borderColor: colors.border }]}
              onPress={() => setShowAdd(false)}
            >
              <Text style={[styles.cancelBtnText, { color: colors.mutedForeground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 }]}
              onPress={handleAdd}
              disabled={saving}
            >
              {saving
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.saveBtnText}>Save</Text>}
            </Pressable>
          </View>
        </View>
      )}

      {/* List */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : vars.length === 0 ? (
        <View style={styles.center}>
          <MaterialCommunityIcons name="key-outline" size={40} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No variables yet</Text>
          <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
            Add key=value pairs that get injected into every run as environment variables.
          </Text>
        </View>
      ) : (
        <FlatList
          data={vars}
          keyExtractor={(item) => item.key}
          contentContainerStyle={{ paddingBottom: bottomPad + 16 }}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
          renderItem={({ item }) => (
            <View style={[styles.row, { backgroundColor: colors.card }]}>
              <View style={styles.rowLeft}>
                <MaterialCommunityIcons name="key-variant" size={16} color={colors.primary} style={{ marginRight: 10 }} />
                <View>
                  <Text style={[styles.keyText, { color: colors.foreground }]}>{item.key}</Text>
                  <Text style={[styles.maskedText, { color: colors.mutedForeground }]}>{item.maskedValue}</Text>
                </View>
              </View>
              <Pressable
                style={[styles.deleteBtn, { backgroundColor: '#f8514922' }]}
                onPress={() => handleDelete(item.key)}
                hitSlop={8}
              >
                <Ionicons name="trash-outline" size={16} color="#f85149" />
              </Pressable>
            </View>
          )}
        />
      )}

      {/* Vault picker modal */}
      <Modal
        visible={showVaultPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowVaultPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowVaultPicker(false)}>
          <Pressable
            style={[styles.modalSheet, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={(e) => e.stopPropagation()}
          >
            {/* Handle */}
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons name="shield-key-outline" size={18} color={colors.primary} />
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>Inject from vault</Text>
              <Pressable onPress={() => setShowVaultPicker(false)} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <Text style={[styles.modalHint, { color: colors.mutedForeground }]}>
              Tap a secret to copy it into this project's environment. The key name is used as-is.
            </Text>
            {vaultLoading ? (
              <View style={styles.center}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : vaultSecrets.length === 0 ? (
              <View style={[styles.center, { paddingVertical: 32 }]}>
                <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                  No vault secrets yet.
                </Text>
                <Pressable
                  style={{ marginTop: 12 }}
                  onPress={() => { setShowVaultPicker(false); router.push('/(app)/secrets'); }}
                >
                  <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '600' }}>
                    Go to Secrets vault →
                  </Text>
                </Pressable>
              </View>
            ) : (
              <FlatList
                data={vaultSecrets}
                keyExtractor={(s) => String(s.id)}
                style={{ maxHeight: 320 }}
                ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [
                      styles.vaultRow,
                      { backgroundColor: pressed ? colors.secondary : colors.card },
                    ]}
                    onPress={() => handleInjectFromVault(item.id, item.name)}
                  >
                    <MaterialCommunityIcons name="shield-key-outline" size={16} color={colors.primary} style={{ marginRight: 10 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.keyText, { color: colors.foreground }]}>{item.name}</Text>
                      {item.description ? (
                        <Text style={[styles.maskedText, { color: colors.mutedForeground }]}>{item.description}</Text>
                      ) : (
                        <Text style={[styles.maskedText, { color: colors.mutedForeground }]}>••••••••••••</Text>
                      )}
                    </View>
                    <Ionicons name="arrow-forward-circle-outline" size={20} color={colors.primary} />
                  </Pressable>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
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
  title: { flex: 1, fontSize: 17, fontWeight: '600' },
  vaultBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  vaultBtnText: { fontSize: 13, fontWeight: '500' },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  addBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  addForm: {
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  addFormTitle: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  addFormHint: { fontSize: 12, lineHeight: 16, marginBottom: 8 },
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
  cancelBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  cancelBtnText: { fontSize: 14, fontWeight: '500' },
  saveBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
  },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 8, textAlign: 'center' },
  emptyHint: { fontSize: 13, textAlign: 'center', lineHeight: 18 },

  separator: { height: StyleSheet.hairlineWidth },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLeft: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  keyText: { fontSize: 14, fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  maskedText: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 2 },
  deleteBtn: { padding: 8, borderRadius: 6 },

  // Vault picker modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingBottom: 32,
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  modalTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  modalHint: { fontSize: 12, lineHeight: 16, paddingHorizontal: 16, paddingBottom: 8 },
  vaultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
