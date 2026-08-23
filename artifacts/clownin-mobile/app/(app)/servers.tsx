import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Alert,
  Modal,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  useListServers,
  useCreateServer,
  useUpdateServer,
  useDeleteServer,
  useTestServerConnection,
  getListServersQueryKey,
} from '@workspace/api-client-react';
import type { ServerConfig } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { getConnectionHint, getErrorLabel } from '@/lib/sshErrorHint';

// ─── Form state ───────────────────────────────────────────────────────────────
interface ServerForm {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey: string;
  useKey: boolean;
}

const DEFAULT_FORM: ServerForm = {
  name: '',
  host: '',
  port: '22',
  username: '',
  password: '',
  privateKey: '',
  useKey: false,
};

function formatTestedAt(ts: number): string {
  const diffMin = Math.floor((Date.now() - ts) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  return 'over an hour ago';
}

export default function ServersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { data: servers = [], isLoading } = useListServers();
  const createMutation = useCreateServer();
  const updateMutation = useUpdateServer();
  const deleteMutation = useDeleteServer();
  const testMutation = useTestServerConnection();

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfig | null>(null);
  const [form, setForm] = useState<ServerForm>(DEFAULT_FORM);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; error?: string; testedAt: number }>>({});

  const openCreate = () => {
    setEditingServer(null);
    setForm(DEFAULT_FORM);
    setShowForm(true);
  };

  const openEdit = (s: ServerConfig) => {
    setEditingServer(s);
    setForm({ name: s.name, host: s.host, port: String(s.port), username: s.username, password: '', privateKey: '', useKey: false });
    setShowForm(true);
  };

  const doSave = async (port: number) => {
    const payload = {
      name: form.name.trim(),
      host: form.host.trim(),
      port,
      username: form.username.trim(),
      ...(form.useKey
        ? { privateKey: form.privateKey.trim() }
        : form.password.trim() ? { password: form.password.trim() } : {}),
    };

    try {
      if (editingServer) {
        await updateMutation.mutateAsync({ id: editingServer.id, data: payload });
      } else {
        await createMutation.mutateAsync({ data: payload });
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
      setShowForm(false);
    } catch {
      Alert.alert('Error', 'Failed to save server. Check your details and try again.');
    }
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      Alert.alert('Missing fields', 'Name, host, and username are required.');
      return;
    }
    if (!form.useKey && !form.password.trim() && !editingServer) {
      Alert.alert('Missing auth', 'Enter a password or paste a private key.');
      return;
    }

    const port = parseInt(form.port, 10) || 22;
    const hostNorm = form.host.trim().toLowerCase();

    const duplicateAddress = servers.find(
      (s) => s.host.toLowerCase() === hostNorm && s.port === port && s.id !== editingServer?.id
    );

    const nameNorm = form.name.trim().toLowerCase();
    const duplicateName = servers.find(
      (s) => s.name.toLowerCase() === nameNorm && s.id !== editingServer?.id
    );

    if (duplicateAddress && duplicateName?.id === duplicateAddress.id) {
      Alert.alert(
        'Duplicate server',
        `"${duplicateAddress.name}" already uses ${form.host.trim()}:${port} and has this name — save anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', onPress: () => doSave(port) },
        ]
      );
      return;
    }

    if (duplicateAddress) {
      Alert.alert(
        'Duplicate address',
        `"${duplicateAddress.name}" already uses ${form.host.trim()}:${port} — save anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', onPress: () => doSave(port) },
        ]
      );
      return;
    }

    if (duplicateName) {
      Alert.alert(
        'Duplicate name',
        `A server named "${form.name.trim()}" already exists — save anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', onPress: () => doSave(port) },
        ]
      );
      return;
    }

    await doSave(port);
  };

  const handleDelete = (s: ServerConfig) => {
    Alert.alert('Remove server', `Remove "${s.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try {
            await deleteMutation.mutateAsync({ id: s.id });
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
          } catch {
            Alert.alert('Error', 'Failed to remove server.');
          }
        },
      },
    ]);
  };

  const handleTest = async (s: ServerConfig) => {
    setTesting(s.id);
    try {
      const res = await testMutation.mutateAsync({ id: s.id });
      setTestResults((prev) => ({ ...prev, [s.id]: { ...res, testedAt: Date.now() } }));
      await Haptics.notificationAsync(
        res.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
      );
    } catch {
      setTestResults((prev) => ({ ...prev, [s.id]: { ok: false, error: 'Request failed', testedAt: Date.now() } }));
    } finally {
      setTesting(null);
    }
  };

  const isBusy = createMutation.isPending || updateMutation.isPending;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Custom Servers</Text>
        <Pressable onPress={openCreate} style={styles.addBtn} hitSlop={8}>
          <Ionicons name="add" size={24} color={colors.primary} />
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : servers.length === 0 ? (
        <View style={styles.centered}>
          <MaterialCommunityIcons name="server-network-off" size={56} color={colors.border} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No servers yet</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            Add an Ubuntu server to run your code remotely over SSH
          </Text>
          <Pressable style={[styles.emptyBtn, { backgroundColor: colors.primary }]} onPress={openCreate}>
            <Text style={styles.emptyBtnText}>Add server</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={servers}
          keyExtractor={(s) => String(s.id)}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
          renderItem={({ item }) => {
            const testResult = testResults[item.id];
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardHeader}>
                  <MaterialCommunityIcons name="server" size={18} color={colors.primary} style={{ marginRight: 8 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardName, { color: colors.foreground }]}>{item.name}</Text>
                    <Text style={[styles.cardHost, { color: colors.mutedForeground }]}>
                      {item.username}@{item.host}:{item.port}
                    </Text>
                  </View>
                  <Pressable onPress={() => openEdit(item)} hitSlop={8} style={styles.iconBtn}>
                    <Ionicons name="pencil-outline" size={16} color={colors.mutedForeground} />
                  </Pressable>
                  <Pressable onPress={() => handleDelete(item)} hitSlop={8} style={styles.iconBtn}>
                    <Ionicons name="trash-outline" size={16} color={colors.destructive} />
                  </Pressable>
                </View>

                {testResult && (
                  <View style={styles.testBadgeWrap}>
                    <View style={[styles.testBadge, { backgroundColor: testResult.ok ? colors.primary + '22' : colors.destructive + '22' }]}>
                      <Ionicons
                        name={testResult.ok ? 'checkmark-circle-outline' : 'close-circle-outline'}
                        size={14}
                        color={testResult.ok ? colors.primary : colors.destructive}
                      />
                      <Text style={[styles.testBadgeText, { color: testResult.ok ? colors.primary : colors.destructive }]}>
                        {testResult.ok ? 'Connected' : getErrorLabel(testResult.error)}
                      </Text>
                      <Text style={[styles.testTimestamp, { color: testResult.ok ? colors.primary + 'aa' : colors.destructive + 'aa' }]}>
                        Tested {formatTestedAt(testResult.testedAt)}
                      </Text>
                    </View>
                    {!testResult.ok && (
                      <View style={styles.testHintRow}>
                        {testResult.error && getConnectionHint(testResult.error) && (
                          <Text style={[styles.testHintText, { color: colors.mutedForeground, flex: 1 }]}>
                            {getConnectionHint(testResult.error)}
                          </Text>
                        )}
                        {testing !== item.id && (
                          <Pressable
                            onPress={() => handleTest(item)}
                            hitSlop={8}
                            style={[styles.retryBtn, { borderColor: colors.destructive + '66' }]}
                          >
                            <Ionicons name="refresh" size={12} color={colors.destructive} />
                            <Text style={[styles.retryBtnText, { color: colors.destructive }]}>Retry</Text>
                          </Pressable>
                        )}
                      </View>
                    )}
                  </View>
                )}

                <Pressable
                  style={[styles.testBtn, { borderColor: colors.border }]}
                  onPress={() => handleTest(item)}
                  disabled={testing === item.id}
                >
                  {testing === item.id
                    ? <ActivityIndicator size="small" color={colors.primary} />
                    : <Text style={[styles.testBtnText, { color: colors.foreground }]}>Test connection</Text>}
                </Pressable>
              </View>
            );
          }}
        />
      )}

      {/* Add / Edit modal */}
      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                {editingServer ? 'Edit server' : 'Add server'}
              </Text>
              <Pressable onPress={() => setShowForm(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.mutedForeground} />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <Field label="Name" colors={colors}>
                <TextInput
                  style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
                  placeholder="My Ubuntu server"
                  placeholderTextColor={colors.mutedForeground}
                  value={form.name}
                  onChangeText={(v) => setForm((f) => ({ ...f, name: v }))}
                  autoCapitalize="none"
                />
              </Field>

              <Field label="Host / IP" colors={colors}>
                <TextInput
                  style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
                  placeholder="192.168.1.100 or example.com"
                  placeholderTextColor={colors.mutedForeground}
                  value={form.host}
                  onChangeText={(v) => setForm((f) => ({ ...f, host: v }))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </Field>

              <View style={styles.row}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Field label="Port" colors={colors}>
                    <TextInput
                      style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
                      placeholder="22"
                      placeholderTextColor={colors.mutedForeground}
                      value={form.port}
                      onChangeText={(v) => setForm((f) => ({ ...f, port: v }))}
                      keyboardType="numeric"
                    />
                  </Field>
                </View>
                <View style={{ flex: 2 }}>
                  <Field label="Username" colors={colors}>
                    <TextInput
                      style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
                      placeholder="ubuntu"
                      placeholderTextColor={colors.mutedForeground}
                      value={form.username}
                      onChangeText={(v) => setForm((f) => ({ ...f, username: v }))}
                      autoCapitalize="none"
                    />
                  </Field>
                </View>
              </View>

              <View style={[styles.switchRow, { borderColor: colors.border }]}>
                <Text style={[styles.switchLabel, { color: colors.foreground }]}>Use private key</Text>
                <Switch
                  value={form.useKey}
                  onValueChange={(v) => setForm((f) => ({ ...f, useKey: v }))}
                  trackColor={{ true: colors.primary }}
                />
              </View>

              {form.useKey ? (
                <Field label="Private key (PEM)" colors={colors}>
                  <TextInput
                    style={[styles.input, styles.keyInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    placeholderTextColor={colors.mutedForeground}
                    value={form.privateKey}
                    onChangeText={(v) => setForm((f) => ({ ...f, privateKey: v }))}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </Field>
              ) : (
                <Field label={editingServer ? 'Password (leave blank to keep existing)' : 'Password'} colors={colors}>
                  <TextInput
                    style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
                    placeholder="••••••••"
                    placeholderTextColor={colors.mutedForeground}
                    value={form.password}
                    onChangeText={(v) => setForm((f) => ({ ...f, password: v }))}
                    secureTextEntry
                  />
                </Field>
              )}
            </ScrollView>

            <View style={styles.modalActions}>
              <Pressable
                style={[styles.cancelBtn, { borderColor: colors.border }]}
                onPress={() => setShowForm(false)}
              >
                <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.saveBtn, { backgroundColor: colors.primary }, isBusy && { opacity: 0.6 }]}
                onPress={handleSave}
                disabled={isBusy}
              >
                {isBusy
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.saveBtnText}>{editingServer ? 'Save' : 'Add server'}</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Field({ label, colors, children }: { label: string; colors: ReturnType<typeof useColors>; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 4, marginRight: 8 },
  headerTitle: { flex: 1, fontSize: 18, fontFamily: 'Inter_600SemiBold' },
  addBtn: { padding: 4 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontFamily: 'Inter_600SemiBold', marginTop: 16 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', marginTop: 6, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  emptyBtnText: { color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 15 },
  list: { padding: 16, gap: 12 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  cardName: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  cardHost: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  iconBtn: { padding: 6 },
  testBadgeWrap: { gap: 4 },
  testBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, alignSelf: 'flex-start' },
  testBadgeText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  testTimestamp: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 1 },
  testHintText: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 16, paddingHorizontal: 2 },
  testHintRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  retryBtnText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  testBtn: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  testBtnText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalBox: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, padding: 20, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: 'Inter_400Regular' },
  keyInput: { minHeight: 100, textAlignVertical: 'top' },
  row: { flexDirection: 'row' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  switchLabel: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { fontSize: 15, fontFamily: 'Inter_500Medium' },
  saveBtn: { flex: 2, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
