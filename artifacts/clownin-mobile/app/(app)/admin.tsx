import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  useGetAdminStats, useListAdminUsers, useUpdateAdminUser,
  useListProviders, useUpdateProvider, useTestProvider,
  useListPromoCodes, useCreatePromoCode, useUpdatePromoCode,
  useDeletePromoCode, useGetPromoCodeRedemptions,
  getListAdminUsersQueryKey, getListProvidersQueryKey, getListPromoCodesQueryKey,
} from '@workspace/api-client-react';
import type { AdminUser, ProviderConfig, PromoCode } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Section = 'overview' | 'providers' | 'users' | 'promo';
const sections: Array<{ key: Section; label: string; icon: string }> = [
  { key: 'overview', label: 'Overview', icon: 'view-dashboard-outline' },
  { key: 'providers', label: 'AI', icon: 'brain' },
  { key: 'users', label: 'Users', icon: 'account-group-outline' },
  { key: 'promo', label: 'Codes', icon: 'ticket-percent-outline' },
];

export default function AdminScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [section, setSection] = useState<Section>('overview');
  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>Admin</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Platform controls</Text>
        </View>
      </View>
      <View style={[styles.tabs, { borderBottomColor: colors.border }]}>
        {sections.map((item) => (
          <Pressable key={item.key} onPress={() => setSection(item.key)}
            style={[styles.tab, section === item.key && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}>
            <MaterialCommunityIcons name={item.icon as any} size={18} color={section === item.key ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.tabText, { color: section === item.key ? colors.primary : colors.mutedForeground }]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {section === 'overview' && <Overview colors={colors} />}
      {section === 'providers' && <Providers colors={colors} />}
      {section === 'users' && <Users colors={colors} />}
      {section === 'promo' && <PromoCodes colors={colors} />}
    </View>
  );
}

function Header({ title, colors }: { title: string; colors: ReturnType<typeof useColors> }) {
  return <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{title}</Text>;
}

function Overview({ colors }: { colors: ReturnType<typeof useColors> }) {
  const { data, isLoading, isError, refetch } = useGetAdminStats();
  if (isLoading) return <Loading colors={colors} />;
  if (isError) return <ErrorState colors={colors} onRetry={refetch} />;
  const cards = [
    ['Total users', data?.userCount ?? 0, 'account-group-outline'],
    ['Pro users', data?.proCount ?? 0, 'crown-outline'],
    ['Projects', data?.projectCount ?? 0, 'folder-outline'],
    ['Promo codes', data?.promoCount ?? 0, 'ticket-percent-outline'],
  ] as const;
  return <ScrollView contentContainerStyle={styles.content}>
    <Header title="Platform overview" colors={colors} />
    <View style={styles.grid}>{cards.map(([label, value, icon]) => (
      <View key={label} style={[styles.stat, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <MaterialCommunityIcons name={icon} size={24} color={colors.primary} />
        <Text style={[styles.statValue, { color: colors.foreground }]}>{value.toLocaleString()}</Text>
        <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
      </View>
    ))}</View>
  </ScrollView>;
}

function Providers({ colors }: { colors: ReturnType<typeof useColors> }) {
  const { data, isLoading, isError, refetch } = useListProviders();
  if (isLoading) return <Loading colors={colors} />;
  if (isError) return <ErrorState colors={colors} onRetry={refetch} />;
  return <FlatList data={data ?? []} keyExtractor={(item) => item.provider}
    contentContainerStyle={styles.content} ListHeaderComponent={<Header title="AI providers" colors={colors} />}
    renderItem={({ item }) => <ProviderCard provider={item} colors={colors} />}
    ItemSeparatorComponent={() => <View style={{ height: 10 }} />} />;
}

function ProviderCard({ provider, colors }: { provider: ProviderConfig; colors: ReturnType<typeof useColors> }) {
  const qc = useQueryClient();
  const update = useUpdateProvider();
  const test = useTestProvider();
  const [key, setKey] = useState('');
  const [model, setModel] = useState(provider.model ?? '');
  const [result, setResult] = useState<string | null>(null);
  const save = (payload: { apiKey?: string; isActive?: boolean; clearKey?: boolean; model?: string | null }) => {
    update.mutate({ provider: provider.provider, data: payload }, {
      onSuccess: () => { setKey(''); qc.invalidateQueries({ queryKey: getListProvidersQueryKey() }); },
      onError: () => Alert.alert('Could not update provider', 'Please try again.'),
    });
  };
  return <View style={[styles.card, { backgroundColor: colors.card, borderColor: provider.isActive ? colors.primary : colors.border }]}>
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>{provider.displayName}</Text>
        <Text style={[styles.mono, { color: colors.mutedForeground }]}>{provider.provider}</Text>
      </View>
      {provider.isActive && <Text style={[styles.active, { color: colors.success }]}>ACTIVE</Text>}
    </View>
    <Text style={[styles.caption, { color: provider.hasApiKey ? colors.success : colors.mutedForeground }]}>
      {provider.hasApiKey ? 'API key configured' : 'No API key configured'}
    </Text>
    {!provider.hasApiKey && <View style={styles.inline}>
      <TextInput value={key} onChangeText={setKey} secureTextEntry placeholder="Paste API key"
        placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
      <SmallButton label="Save" onPress={() => key.trim() && save({ apiKey: key.trim() })} colors={colors} />
    </View>}
    {provider.hasApiKey && <View style={styles.buttonRow}>
      <SmallButton label="Clear key" onPress={() => save({ clearKey: true })} colors={colors} />
      <SmallButton label="Test" onPress={() => { setResult(null); test.mutate({ provider: provider.provider }, { onSuccess: (r) => setResult(r.ok ? `Connected: ${r.response ?? 'ok'}` : r.error ?? 'Provider failed'), onError: () => setResult('Provider test failed') }); }} colors={colors} />
    </View>}
    <View style={styles.inline}>
      <TextInput value={model} onChangeText={setModel} placeholder="Model override (optional)"
        placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
      <SmallButton label="Save model" onPress={() => save({ model: model.trim() || null })} colors={colors} />
    </View>
    {!provider.isActive && <SmallButton label="Set active" onPress={() => save({ isActive: true })} colors={colors} />}
    {result && <Text style={[styles.result, { color: result.startsWith('Connected') ? colors.success : colors.destructive }]}>{result}</Text>}
  </View>;
}

function Users({ colors }: { colors: ReturnType<typeof useColors> }) {
  const { data, isLoading, isError, refetch } = useListAdminUsers();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const filtered = useMemo(() => (data ?? []).filter((u) => `${u.username} ${u.email}`.toLowerCase().includes(search.toLowerCase())), [data, search]);
  if (isLoading) return <Loading colors={colors} />;
  if (isError) return <ErrorState colors={colors} onRetry={refetch} />;
  return <View style={styles.flex}>
    <View style={styles.content}><Header title="Users" colors={colors} />
      <TextInput value={search} onChangeText={setSearch} placeholder="Search users"
        placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
    </View>
    <FlatList data={filtered} keyExtractor={(u) => String(u.id)} contentContainerStyle={styles.content}
      renderItem={({ item }) => <Pressable onPress={() => setSelected(item)} style={[styles.userRow, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}><Text style={[styles.cardTitle, { color: colors.foreground }]}>{item.username}</Text><Text style={[styles.caption, { color: colors.mutedForeground }]}>{item.email} · {item.projectCount} projects</Text></View>
        <View style={{ alignItems: 'flex-end' }}><Text style={[styles.badge, { color: item.subscriptionTier === 'pro' ? colors.primary : colors.mutedForeground }]}>{item.subscriptionTier.toUpperCase()}</Text><Text style={[styles.caption, { color: colors.mutedForeground }]}>{item.dailyMessageCount} daily msgs</Text></View>
      </Pressable>}
    />
    {selected && <UserEditor user={selected} colors={colors} onClose={() => setSelected(null)} />}
  </View>;
}

function UserEditor({ user, colors, onClose }: { user: AdminUser; colors: ReturnType<typeof useColors>; onClose: () => void }) {
  const qc = useQueryClient();
  const update = useUpdateAdminUser();
  const [tier, setTier] = useState(user.subscriptionTier);
  const [count, setCount] = useState(String(user.dailyMessageCount));
  return <Modal transparent animationType="slide" visible onRequestClose={onClose}><View style={styles.modalBackdrop}><View style={[styles.sheet, { backgroundColor: colors.card }]}>
    <Text style={[styles.cardTitle, { color: colors.foreground }]}>Edit {user.username}</Text>
    <Text style={[styles.caption, { color: colors.mutedForeground }]}>{user.email}</Text>
    <Text style={[styles.label, { color: colors.mutedForeground }]}>Subscription tier</Text>
    <View style={styles.buttonRow}><SmallButton label="Free" onPress={() => setTier('free')} colors={colors} active={tier === 'free'} /><SmallButton label="Pro" onPress={() => setTier('pro')} colors={colors} active={tier === 'pro'} /></View>
    <Text style={[styles.label, { color: colors.mutedForeground }]}>Daily message count</Text>
    <TextInput value={count} onChangeText={setCount} keyboardType="number-pad" style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
    <View style={styles.buttonRow}><SmallButton label="Cancel" onPress={onClose} colors={colors} /><SmallButton label="Save changes" onPress={() => update.mutate({ id: user.id, data: { subscriptionTier: tier, dailyMessageCount: Math.max(0, parseInt(count, 10) || 0) } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListAdminUsersQueryKey() }); onClose(); }, onError: () => Alert.alert('Could not update user', 'Please try again.') })} colors={colors} /></View>
  </View></View></Modal>;
}

function PromoCodes({ colors }: { colors: ReturnType<typeof useColors> }) {
  const { data, isLoading, isError, refetch } = useListPromoCodes();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<PromoCode | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (isLoading) return <Loading colors={colors} />;
  if (isError) return <ErrorState colors={colors} onRetry={refetch} />;
  return <View style={styles.flex}><View style={[styles.content, styles.row]}><Header title="Promo codes" colors={colors} /><SmallButton label="New code" onPress={() => setShowCreate(true)} colors={colors} /></View>
    <FlatList data={data ?? []} keyExtractor={(c) => String(c.id)} contentContainerStyle={styles.content}
      renderItem={({ item }) => <PromoRow code={item} colors={colors} expanded={expanded === item.id} onExpand={() => setExpanded(expanded === item.id ? null : item.id)} onEdit={() => setEditing(item)} />}
    />
    {showCreate && <PromoEditor colors={colors} onClose={() => setShowCreate(false)} />}
    {editing && <PromoEditor colors={colors} code={editing} onClose={() => setEditing(null)} />}
  </View>;
}

function PromoRow({ code, colors, expanded, onExpand, onEdit }: { code: PromoCode; colors: ReturnType<typeof useColors>; expanded: boolean; onExpand: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const update = useUpdatePromoCode();
  const del = useDeletePromoCode();
  const { data: redemptions } = useGetPromoCodeRedemptions(code.id);
  return <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
    <Pressable onPress={onExpand} style={styles.row}><View style={{ flex: 1 }}><Text style={[styles.code, { color: colors.foreground }]}>{code.code}</Text><Text style={[styles.caption, { color: colors.mutedForeground }]}>{code.usedCount} / {code.maxUses} uses · {code.expiresAt ? new Date(code.expiresAt).toLocaleDateString() : 'Never expires'}</Text></View><Text style={[styles.badge, { color: code.isActive ? colors.success : colors.mutedForeground }]}>{code.isActive ? 'ACTIVE' : 'INACTIVE'}</Text></Pressable>
    <View style={styles.buttonRow}><SmallButton label={code.isActive ? 'Deactivate' : 'Activate'} onPress={() => update.mutate({ id: code.id, data: { isActive: !code.isActive } }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListPromoCodesQueryKey() }) })} colors={colors} /><SmallButton label="Edit" onPress={onEdit} colors={colors} /><SmallButton label="Delete" onPress={() => Alert.alert('Delete promo code?', code.code, [{ text: 'Cancel' }, { text: 'Delete', style: 'destructive', onPress: () => del.mutate({ id: code.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListPromoCodesQueryKey() }) }) }])} colors={colors} /></View>
    {expanded && <View style={styles.redemptions}><Text style={[styles.caption, { color: colors.mutedForeground }]}>Redemptions: {redemptions?.length ?? 0}</Text>{redemptions?.map((r) => <Text key={r.id} style={[styles.caption, { color: colors.foreground }]}>{r.username ?? r.email ?? `User ${r.userId}`} · {new Date(r.redeemedAt).toLocaleDateString()}</Text>)}</View>}
  </View>;
}

function PromoEditor({ colors, code, onClose }: { colors: ReturnType<typeof useColors>; code?: PromoCode; onClose: () => void }) {
  const qc = useQueryClient();
  const create = useCreatePromoCode();
  const update = useUpdatePromoCode();
  const [maxUses, setMaxUses] = useState(String(code?.maxUses ?? 1));
  const [expires, setExpires] = useState(code?.expiresAt ? new Date(code.expiresAt).toISOString().slice(0, 10) : '');
  const [notes, setNotes] = useState(code?.notes ?? '');
  const save = () => {
    const data = { maxUses: Math.max(1, parseInt(maxUses, 10) || 1), expiresAt: expires ? new Date(expires).toISOString() : null, notes: notes || null };
    if (code) update.mutate({ id: code.id, data: { ...data, isActive: code.isActive } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListPromoCodesQueryKey() }); onClose(); } });
    else create.mutate({ data: { ...data, tier: 'pro' } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListPromoCodesQueryKey() }); onClose(); } });
  };
  return <Modal transparent animationType="slide" visible onRequestClose={onClose}><View style={styles.modalBackdrop}><ScrollView style={[styles.sheet, { backgroundColor: colors.card }]} contentContainerStyle={{ gap: 10 }}>
    <Text style={[styles.cardTitle, { color: colors.foreground }]}>{code ? `Edit ${code.code}` : 'New promo code'}</Text>
    <TextInput value={maxUses} onChangeText={setMaxUses} keyboardType="number-pad" placeholder="Max uses" placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
    <TextInput value={expires} onChangeText={setExpires} placeholder="Expiry date (YYYY-MM-DD)" placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
    <TextInput value={notes} onChangeText={setNotes} placeholder="Notes (optional)" placeholderTextColor={colors.mutedForeground} style={[styles.input, styles.multiline, { color: colors.foreground, borderColor: colors.border }]} multiline />
    <View style={styles.buttonRow}><SmallButton label="Cancel" onPress={onClose} colors={colors} /><SmallButton label={code ? 'Save' : 'Generate'} onPress={save} colors={colors} /></View>
  </ScrollView></View></Modal>;
}

function SmallButton({ label, onPress, colors, active = false }: { label: string; onPress: () => void; colors: ReturnType<typeof useColors>; active?: boolean }) {
  return <Pressable onPress={onPress} style={[styles.smallButton, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + '22' : colors.background }]}><Text style={[styles.smallButtonText, { color: active ? colors.primary : colors.foreground }]}>{label}</Text></Pressable>;
}
function Loading({ colors }: { colors: ReturnType<typeof useColors> }) { return <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>; }
function ErrorState({ colors, onRetry }: { colors: ReturnType<typeof useColors>; onRetry: () => void }) { return <View style={styles.center}><Text style={[styles.caption, { color: colors.destructive }]}>Could not load admin data.</Text><SmallButton label="Retry" onPress={onRetry} colors={colors} /></View>; }

const styles = StyleSheet.create({
  root: { flex: 1 }, flex: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 }, back: { padding: 4 }, title: { fontSize: 22, fontFamily: 'Inter_700Bold' }, subtitle: { fontSize: 12, marginTop: 2 }, tabs: { flexDirection: 'row', borderBottomWidth: 1 }, tab: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10 }, tabText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' }, content: { padding: 16, gap: 12 }, sectionTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', marginBottom: 2 }, label: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 4 }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, stat: { width: '48%', minHeight: 125, borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 }, statValue: { fontSize: 28, fontFamily: 'Inter_700Bold' }, statLabel: { fontSize: 12 }, card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 }, row: { flexDirection: 'row', alignItems: 'center', gap: 10 }, cardTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' }, mono: { fontSize: 11, fontFamily: 'monospace', marginTop: 2 }, caption: { fontSize: 12 }, active: { fontSize: 10, fontFamily: 'Inter_700Bold' }, inline: { flexDirection: 'row', alignItems: 'center', gap: 8 }, input: { flex: 1, minHeight: 42, borderWidth: 1, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, fontSize: 13 }, multiline: { minHeight: 82, textAlignVertical: 'top' }, buttonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, smallButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 8 }, smallButtonText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' }, result: { fontSize: 12 }, userRow: { flexDirection: 'row', paddingVertical: 13, borderBottomWidth: 1, gap: 8 }, badge: { fontSize: 10, fontFamily: 'Inter_700Bold' }, code: { fontFamily: 'monospace', fontSize: 15, fontWeight: '700' }, redemptions: { borderTopWidth: 1, borderTopColor: '#00000018', paddingTop: 8, gap: 4 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }, modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000066' }, sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '85%', gap: 12 },
});