import React, { useRef, useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Image,
  ScrollView,
  Alert,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
// @ts-ignore — expo/fetch provides streaming on native + web
import { fetch as expoFetch } from "expo/fetch";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { useColors } from "@/hooks/useColors";
import { resolveApiBaseUrl } from "@/app/_layout";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { PaywallSheet, type PaywallReason } from "./PaywallSheet";
import { useProfile, PROFILE_QUERY_KEY } from "@/hooks/useProfile";

type Attachment =
  | { kind: "image"; name: string; base64: string; mimeType: string; preview: string }
  | { kind: "text"; name: string; content: string }
  | { kind: "zip"; name: string; base64: string };

// ── Types ─────────────────────────────────────────────────────────────────────
type ToolCallMsg = {
  id: string;
  kind: "tool_call";
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
};

type TextMsg = {
  id: string;
  kind: "user" | "agent";
  text: string;
  streaming?: boolean;
  createdAt?: string;
};

type ThinkingMsg = { id: string; kind: "thinking"; statusText?: string };

type DateDividerMsg = { id: string; kind: "date_divider"; label: string };

type AgentMsg = TextMsg | ToolCallMsg | ThinkingMsg | DateDividerMsg;

// Pair sent to backend as history
type HistoryEntry = { role: "user" | "assistant"; content: string };

// Summary of a past session returned by the sessions list endpoint
type SessionSummary = {
  sessionId: string | null;
  name: string | null;
  preview: string;
  messageCount: number;
  startedAt: string;
  lastAt: string;
};

// ── Date divider helpers ──────────────────────────────────────────────────────
function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const msgStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgStart.getTime() === todayStart.getTime()) return "Today";
  if (msgStart.getTime() === yesterdayStart.getTime()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function calendarDay(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Insert DateDividerMsg items between messages that cross a calendar day boundary. */
function injectDateDividers(msgs: AgentMsg[]): AgentMsg[] {
  const result: AgentMsg[] = [];
  let lastDay: string | null = null;
  for (const msg of msgs) {
    const dateStr = (msg as TextMsg).createdAt;
    if (dateStr) {
      const day = calendarDay(dateStr);
      if (day !== lastDay) {
        result.push({ id: `divider-${day}`, kind: "date_divider", label: formatDateLabel(dateStr) });
        lastDay = day;
      }
    }
    result.push(msg);
  }
  return result;
}

/** Mirrors the server-side auto-naming heuristic: first 6 words, trailing punctuation stripped. */
function autoNameFromMessage(msg: string): string {
  return msg.trim().split(/\s+/).slice(0, 6).join(" ").replace(/[.!?]+$/, "");
}

// Simple UUID v4 generator — works on all Hermes / web environments
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Thinking bubble (animated) ────────────────────────────────────────────────
const THINKING_PHRASES = [
  "Thinking through your request…",
  "Reading your project…",
  "Planning the changes…",
  "Working out the details…",
  "Putting it together…",
  "Almost ready…",
];

function ThinkingBubble({ statusText, colors }: {
  statusText?: string;
  colors: ReturnType<typeof useColors>;
}) {
  const [phraseIdx, setPhraseIdx] = useState(0);

  useEffect(() => {
    if (statusText) return; // server is narrating — don't cycle
    const id = setInterval(
      () => setPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length),
      2500,
    );
    return () => clearInterval(id);
  }, [statusText]);

  return (
    <View style={thinkStyles.row}>
      <View style={[thinkStyles.bubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[thinkStyles.text, { color: colors.mutedForeground }]}>
          {statusText ?? THINKING_PHRASES[phraseIdx]}
        </Text>
      </View>
    </View>
  );
}

const thinkStyles = StyleSheet.create({
  row:    { paddingHorizontal: 16, paddingVertical: 4, alignItems: "flex-start" },
  bubble: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, borderWidth: 1, maxWidth: "80%" },
  text:   { fontSize: 13, fontFamily: "Inter_400Regular" },
});

// ── Past session collapsed card ───────────────────────────────────────────────
type PastSessionCardProps = {
  projectId: number;
  session: SessionSummary;
  colors: ReturnType<typeof useColors>;
  onDelete: () => void;
  onRename: (newName: string) => void;
};

function PastSessionCard({ projectId, session, colors, onDelete, onRename }: PastSessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<Array<{ id: number; role: string; content: string }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(session.name ?? "");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<TextInput>(null);
  const { token } = useAuth();

  const toggle = useCallback(async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (messages !== null) return; // already loaded
    if (!token) return;
    // "legacy" is the API sentinel for pre-migration rows where session_id IS NULL
    const apiSessionId = session.sessionId ?? "legacy";
    setLoading(true);
    try {
      const baseUrl = resolveApiBaseUrl();
      const r = await fetch(
        `${baseUrl}/api/projects/${projectId}/conversations/${apiSessionId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (r.ok) setMessages(await r.json());
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, [expanded, messages, session.sessionId, token, projectId]);

  const startEdit = useCallback((e: { stopPropagation?: () => void }) => {
    e.stopPropagation?.();
    setNameInput(session.name ?? session.preview.slice(0, 60) ?? "");
    setEditingName(true);
    setTimeout(() => nameRef.current?.focus(), 50);
  }, [session.name, session.preview]);

  const commitName = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || !session.sessionId || !token) { setEditingName(false); return; }
    setSaving(true);
    try {
      const baseUrl = resolveApiBaseUrl();
      const r = await fetch(
        `${baseUrl}/api/projects/${projectId}/conversations/${session.sessionId}/name`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: trimmed }),
        },
      );
      if (r.ok) {
        onRename(trimmed);
      } else {
        // Revert the input to the last committed name on failure
        setNameInput(session.name ?? "");
      }
    } catch {
      setNameInput(session.name ?? "");
    } finally { setSaving(false); setEditingName(false); }
  }, [nameInput, session.sessionId, session.name, projectId, token, onRename]);

  const label = new Date(session.lastAt).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });

  const displayName = session.name || session.preview || "(no preview)";

  return (
    <View style={[pastStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Pressable style={pastStyles.header} onPress={toggle} hitSlop={4}>
        <MaterialCommunityIcons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={14}
          color={colors.mutedForeground}
        />
        <View style={{ flex: 1 }}>
          {editingName ? (
            <TextInput
              ref={nameRef}
              style={[pastStyles.nameInput, { color: colors.foreground, borderColor: colors.primary }]}
              value={nameInput}
              onChangeText={setNameInput}
              onSubmitEditing={commitName}
              onBlur={commitName}
              returnKeyType="done"
              maxLength={80}
              editable={!saving}
            />
          ) : (
            <Pressable onPress={startEdit} hitSlop={4}>
              <Text style={[pastStyles.name, { color: colors.foreground }]} numberOfLines={1}>
                {displayName}
              </Text>
            </Pressable>
          )}
          <Text style={[pastStyles.meta, { color: colors.mutedForeground }]}>
            {label} · {session.messageCount} message{session.messageCount !== 1 ? "s" : ""}
          </Text>
        </View>
        {saving ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} style={{ padding: 2 }} />
        ) : (
          <Pressable
            onPress={(e) => { e.stopPropagation?.(); onDelete(); }}
            hitSlop={8}
            style={{ padding: 2 }}
          >
            <MaterialCommunityIcons name="delete-outline" size={14} color={colors.mutedForeground} />
          </Pressable>
        )}
      </Pressable>

      {expanded && (
        loading ? (
          <ActivityIndicator size="small" color={colors.primary} style={{ padding: 10 }} />
        ) : (
          <View style={pastStyles.body}>
            {session.preview ? (
              <Text style={[pastStyles.previewText, { color: colors.mutedForeground }]} numberOfLines={2}>
                {session.preview}
              </Text>
            ) : null}
            {(messages ?? []).map((m) => (
              <View
                key={m.id}
                style={[
                  pastStyles.msgBubble,
                  m.role === "user"
                    ? { backgroundColor: colors.primary, alignSelf: "flex-end" }
                    : { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, alignSelf: "flex-start" },
                ]}
              >
                <Text style={[pastStyles.msgText, { color: m.role === "user" ? "#fff" : colors.foreground }]} numberOfLines={6}>
                  {m.content}
                </Text>
              </View>
            ))}
          </View>
        )
      )}
    </View>
  );
}

const pastStyles = StyleSheet.create({
  card:        { marginHorizontal: 10, marginBottom: 6, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  header:      { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  name:        { fontSize: 12, fontFamily: "Inter_500Medium" },
  nameInput:   { fontSize: 12, fontFamily: "Inter_400Regular", borderBottomWidth: 1, paddingVertical: 1, paddingHorizontal: 0 },
  meta:        { fontSize: 10, marginTop: 1 },
  previewText: { fontSize: 11, fontFamily: "Inter_400Regular", paddingHorizontal: 0, paddingBottom: 4, fontStyle: "italic" },
  body:        { paddingHorizontal: 10, paddingBottom: 10, gap: 6 },
  msgBubble:   { maxWidth: "80%", paddingHorizontal: 10, paddingVertical: 7, borderRadius: 12 },
  msgText:     { fontSize: 12, lineHeight: 17 },
});

// ── Tool label helpers ────────────────────────────────────────────────────────
function toolLabel(tool: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  switch (tool) {
    case "list_files":       return "Listing files…";
    case "read_file":        return path ? `Reading ${path}` : "Reading file…";
    case "write_file":       return path ? `Writing ${path}` : "Writing file…";
    case "create_file":      return path ? `Creating ${path}` : "Creating file…";
    case "delete_file":      return path ? `Deleting ${path}` : "Deleting file…";
    case "edit_file":        return path ? `Editing ${path}` : "Editing file…";
    case "rename_file": {
      const op = typeof args.old_path === "string" ? args.old_path : "";
      const np = typeof args.new_path === "string" ? args.new_path : "";
      return op && np ? `${op} → ${np}` : "Renaming file…";
    }
    case "run_code":         return path ? `Running ${path}` : "Running code…";
    case "run_terminal": {
      const cmd = typeof args.command === "string" ? args.command.slice(0, 40) : "";
      return cmd ? `$ ${cmd}` : "Running command…";
    }
    case "install_packages": {
      const pkgs = Array.isArray(args.packages) ? (args.packages as string[]).join(", ") : "";
      return pkgs ? `Installing ${pkgs}` : "Installing packages…";
    }
    case "search_files": {
      const pat = typeof args.pattern === "string" ? args.pattern : "";
      return pat ? `Search: "${pat}"` : "Searching files…";
    }
    case "fetch_url": {
      const u = typeof args.url === "string" ? args.url : "";
      try { return `Fetching ${new URL(u).hostname}`; } catch { return "Fetching URL…"; }
    }
    case "enable_preview":   return "Setting up preview link…";
    case "deploy": {
      const platform = typeof args.platform === "string" ? args.platform : "hosting";
      return `Deploying to ${platform}…`;
    }
    default:                 return tool.replace(/_/g, " ");
  }
}

function toolIcon(tool: string): string {
  switch (tool) {
    case "list_files":       return "format-list-bulleted";
    case "read_file":        return "file-eye-outline";
    case "write_file":
    case "create_file":      return "file-edit-outline";
    case "edit_file":        return "file-find-outline";
    case "delete_file":      return "file-remove-outline";
    case "rename_file":      return "file-move-outline";
    case "run_code":         return "play-circle-outline";
    case "run_terminal":     return "console";
    case "install_packages": return "package-down";
    case "search_files":     return "magnify";
    case "fetch_url":        return "web";
    case "enable_preview":   return "link-variant";
    case "deploy":           return "rocket-launch-outline";
    default:                 return "wrench-outline";
  }
}

// ── Main component ────────────────────────────────────────────────────────────
interface AgentChatProps {
  projectId: number;
  onFilesChanged?: () => void;
  /** When provided, automatically sent to the agent as the first message on mount. */
  initialMessage?: string;
}

export function AgentChat({ projectId, onFilesChanged, initialMessage }: AgentChatProps) {
  const colors = useColors();
  const { token } = useAuth();

  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallReason, setPaywallReason] = useState<PaywallReason>('daily_limit');
  const listRef = useRef<FlatList>(null);
  // Prevents the auto-send from firing more than once per mount
  const autoSentRef = useRef(false);

  // Conversation history for the backend (only user + assistant text)
  const historyRef = useRef<HistoryEntry[]>([]);
  // Current streaming agent message id
  const streamingIdRef = useRef<string | null>(null);
  // True once the initial history fetch has completed (success or failure)
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // ── Session state ─────────────────────────────────────────────────────────
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const [pastSessions, setPastSessions] = useState<SessionSummary[]>([]);

  // ── Active session name (inline rename) ───────────────────────────────────
  const [currentSessionName, setCurrentSessionName] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState(false);
  const [sessionNameInput, setSessionNameInput] = useState("");
  const [savingSessionName, setSavingSessionName] = useState(false);
  const sessionNameRef = useRef<TextInput>(null);

  const { data: profile } = useProfile();
  const queryClient = useQueryClient();

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  // ── Load sessions and current session's messages on mount ─────────────────
  useEffect(() => {
    if (!token) { setHistoryLoaded(true); return; }
    const baseUrl = resolveApiBaseUrl();

    fetch(`${baseUrl}/api/projects/${projectId}/conversations`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then(async (sessions: SessionSummary[]) => {
        if (!sessions.length) return;

        // Most recent session is the current one; all others are past
        const [latest, ...older] = sessions;
        setPastSessions(older);

        // "legacy" is the API sentinel for pre-migration rows where session_id IS NULL.
        // We still load their messages but leave currentSessionId as null so that
        // the next message the user sends starts a fresh UUID session.
        const apiSessionId = latest.sessionId ?? "legacy";

        if (latest.sessionId) {
          currentSessionIdRef.current = latest.sessionId;
          setCurrentSessionId(latest.sessionId);
          if (latest.name) setCurrentSessionName(latest.name);
        }
        // (null sessionId → currentSessionId stays null → next send creates a new UUID session)

        // Load messages for the current session
        try {
          const r = await fetch(
            `${baseUrl}/api/projects/${projectId}/conversations/${apiSessionId}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!r.ok) return;
          const data: Array<{ id: number; role: string; content: string; createdAt?: string }> = await r.json();
          if (!data.length) return;
          const rawMsgs: AgentMsg[] = data.map((m) => ({
            id: `hist-${m.id}`,
            kind: m.role === "user" ? "user" : "agent",
            text: m.content,
            streaming: false,
            createdAt: m.createdAt,
          }));
          setMessages(injectDateDividers(rawMsgs));
          historyRef.current = data.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
        } catch { /* non-fatal */ }
      })
      .catch(() => {/* non-fatal */})
      .finally(() => setHistoryLoaded(true));
  // Only run once per projectId mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ── Start a new conversation ───────────────────────────────────────────────
  const startNewConversation = useCallback(() => {
    const newId = generateUUID();
    currentSessionIdRef.current = newId;
    setCurrentSessionId(newId);
    setCurrentSessionName(null);
    setMessages([]);
    historyRef.current = [];
  }, []);

  // ── Rename the active session ─────────────────────────────────────────────
  const commitSessionName = useCallback(async () => {
    const trimmed = sessionNameInput.trim();
    setEditingSessionName(false);
    if (!trimmed || !currentSessionIdRef.current || !token) return;
    setSavingSessionName(true);
    try {
      const baseUrl = resolveApiBaseUrl();
      const r = await fetch(
        `${baseUrl}/api/projects/${projectId}/conversations/${currentSessionIdRef.current}/name`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: trimmed }),
        },
      );
      if (r.ok) {
        setCurrentSessionName(trimmed);
      } else {
        // Revert input on failure
        setSessionNameInput(currentSessionName ?? "");
      }
    } catch {
      setSessionNameInput(currentSessionName ?? "");
    } finally {
      setSavingSessionName(false);
    }
  }, [sessionNameInput, projectId, token, currentSessionName]);

  // ── Clear current session (delete + reset) ─────────────────────────────────
  const clearConversation = useCallback(async () => {
    if (!token) {
      setMessages([]);
      historyRef.current = [];
      return;
    }
    // "legacy" is the API sentinel for pre-migration rows where session_id IS NULL.
    // Even when currentSessionIdRef is null (legacy session active), we still call
    // the API so the rows are actually deleted rather than just cleared locally.
    const apiSessionId = currentSessionIdRef.current ?? "legacy";
    try {
      const baseUrl = resolveApiBaseUrl();
      await fetch(
        `${baseUrl}/api/projects/${projectId}/conversations/${apiSessionId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      setMessages([]);
      historyRef.current = [];
      currentSessionIdRef.current = null;
      setCurrentSessionId(null);
    } catch { /* non-fatal */ }
  }, [projectId, token]);

  // ── Delete a past session ─────────────────────────────────────────────────
  const deletePastSession = useCallback(async (sessionId: string | null) => {
    if (!token) return;
    // "legacy" is the API sentinel for pre-migration rows with session_id IS NULL
    const apiSessionId = sessionId ?? "legacy";
    try {
      const baseUrl = resolveApiBaseUrl();
      await fetch(
        `${baseUrl}/api/projects/${projectId}/conversations/${apiSessionId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      setPastSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    } catch { /* non-fatal */ }
  }, [projectId, token]);

  const upsertMsg = useCallback((msg: AgentMsg) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id);
      if (idx === -1) return [...prev, msg];
      const next = [...prev];
      next[idx] = msg;
      return next;
    });
  }, []);

  const pickImage = useCallback(async () => {
    setPickerOpen(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { Alert.alert("Permission needed", "Allow photo access to attach images."); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const name = asset.fileName ?? `image-${Date.now()}.jpg`;
      const mimeType = asset.mimeType ?? "image/jpeg";
      const base64 = asset.base64 ?? "";
      setAttachments((prev) => [...prev, { kind: "image", name, base64, mimeType, preview: asset.uri }]);
    }
  }, []);

  const pickFile = useCallback(async () => {
    setPickerOpen(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const lowerName = asset.name.toLowerCase();
      const isZip =
        lowerName.endsWith(".zip") ||
        asset.mimeType === "application/zip" ||
        asset.mimeType === "application/x-zip-compressed";
      if (isZip) {
        const resp = await fetch(asset.uri);
        const blob = await resp.blob();
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const raw = (reader.result as string).split(",")[1] ?? "";
            resolve(raw);
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        setAttachments((prev) => [...prev, { kind: "zip", name: asset.name, base64 }]);
      } else {
        const content = await FileSystem.readAsStringAsync(asset.uri);
        setAttachments((prev) => [...prev, { kind: "text", name: asset.name, content }]);
      }
    } catch {
      Alert.alert("Could not read file", "Only text, code, and .zip files are supported.");
    }
  }, []);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Auto-send initialMessage once on mount — wait for history to load first
  React.useEffect(() => {
    if (!historyLoaded || !initialMessage || autoSentRef.current) return;
    autoSentRef.current = true;
    const timer = setTimeout(() => send(initialMessage), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if ((!text && attachments.length === 0) || busy) return;

    // Proactive daily limit check (avoids a round trip when we already know)
    if (profile?.subscriptionTier === 'free' && profile.dailyMessageLimit !== null) {
      if ((profile.dailyMessageCount ?? 0) >= (profile.dailyMessageLimit ?? 20)) {
        setPaywallReason('daily_limit');
        setShowPaywall(true);
        return;
      }
    }

    if (!overrideText) setInput("");
    setBusy(true);
    setPickerOpen(false);

    const sentAttachments = attachments;
    setAttachments([]);

    const displayText = text
      ? `${text}${sentAttachments.length ? "\n" + sentAttachments.map((a) => `📎 ${a.name}`).join("\n") : ""}`
      : sentAttachments.map((a) => `📎 ${a.name}`).join(", ");

    const userMsgId = `u-${Date.now()}`;
    upsertMsg({ id: userMsgId, kind: "user", text: displayText });
    historyRef.current = [...historyRef.current, { role: "user", content: text || displayText }];
    scrollToBottom();

    // Thinking indicator
    const thinkId = `think-${Date.now()}`;
    upsertMsg({ id: thinkId, kind: "thinking" });
    scrollToBottom();

    let agentText = "";
    const agentMsgId = `a-${Date.now()}`;
    streamingIdRef.current = agentMsgId;
    let agentMsgCreated = false;

    // Map callId → message id for tool cards
    const toolCardIds = new Map<string, string>();

    // If starting fresh with a pre-generated sessionId but no messages yet,
    // the server will confirm the same sessionId back; track it locally.
    const outboundSessionId = currentSessionIdRef.current;

    try {
      const baseUrl = resolveApiBaseUrl();
      const response = await expoFetch(`${baseUrl}/api/projects/${projectId}/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: text || "(see attachments)",
          history: historyRef.current.slice(-20),
          attachments: sentAttachments.map((a) =>
            a.kind === "image"
              ? { kind: "image", name: a.name, base64: a.base64, mimeType: a.mimeType }
              : a.kind === "zip"
              ? { kind: "zip", name: a.name, base64: a.base64 }
              : { kind: "text", name: a.name, content: a.content }
          ),
          // Explicit session — tells the server which thread to write into
          ...(outboundSessionId ? { sessionId: outboundSessionId } : {}),
        }),
        // @ts-ignore
        reactNative: { textStreaming: true },
      });

      if (response.status === 402) {
        try { await response.json(); } catch { /* ignore */ }
        setMessages((prev) => prev.filter((m) => m.id !== thinkId));
        setPaywallReason('daily_limit');
        setShowPaywall(true);
        return;
      }

      if (response.status === 413) {
        throw new Error("That image is too large to send. Try a smaller one.");
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      // Remove thinking indicator once we start getting real events
      let thinkingRemoved = false;
      const removeThinking = () => {
        if (!thinkingRemoved) {
          thinkingRemoved = true;
          setMessages((prev) => prev.filter((m) => m.id !== thinkId));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let event: { type: string; payload?: unknown };
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          switch (event.type) {
            case "thinking":
              break;

            case "status": {
              const { text: statusText } = event.payload as { text: string };
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === thinkId ? { ...m, statusText } as ThinkingMsg : m,
                ),
              );
              break;
            }

            case "token": {
              removeThinking();
              agentText += event.payload as string;
              if (!agentMsgCreated) {
                agentMsgCreated = true;
                upsertMsg({ id: agentMsgId, kind: "agent", text: agentText, streaming: true });
              } else {
                upsertMsg({ id: agentMsgId, kind: "agent", text: agentText, streaming: true });
              }
              scrollToBottom();
              break;
            }

            case "tool_call": {
              removeThinking();
              const { tool, args, callId } = event.payload as {
                tool: string; args: Record<string, unknown>; callId: string;
              };
              const cardId = `tc-${callId}`;
              toolCardIds.set(callId, cardId);
              upsertMsg({ id: cardId, kind: "tool_call", tool, args });
              scrollToBottom();
              break;
            }

            case "tool_result": {
              const { callId, result, isError } = event.payload as {
                callId: string; tool: string; result: string; isError: boolean;
              };
              const cardId = toolCardIds.get(callId);
              if (cardId) {
                setMessages((prev) => prev.map((m) =>
                  m.id === cardId ? { ...m, result, isError } as ToolCallMsg : m
                ));
                onFilesChanged?.();
              }
              break;
            }

            case "message": {
              removeThinking();
              const { text: msgText } = event.payload as { text: string };
              if (agentMsgCreated) {
                upsertMsg({ id: agentMsgId, kind: "agent", text: agentText, streaming: false });
              } else {
                upsertMsg({ id: agentMsgId, kind: "agent", text: msgText, streaming: false });
                agentText = msgText;
                agentMsgCreated = true;
              }
              scrollToBottom();
              break;
            }

            case "done": {
              removeThinking();
              if (agentMsgCreated) {
                upsertMsg({ id: agentMsgId, kind: "agent", text: agentText, streaming: false });
              }
              if (agentText) {
                historyRef.current = [
                  ...historyRef.current,
                  { role: "assistant", content: agentText },
                ];
              }
              // Capture the sessionId the server used for this turn
              const { sessionId: serverSessionId } = (event.payload ?? {}) as { sessionId?: string };
              if (serverSessionId && serverSessionId !== currentSessionIdRef.current) {
                currentSessionIdRef.current = serverSessionId;
                setCurrentSessionId(serverSessionId);
              }
              break;
            }

            case "error": {
              removeThinking();
              const { message: errMsg } = event.payload as { message: string };
              upsertMsg({ id: `err-${Date.now()}`, kind: "agent", text: `⚠️ ${errMsg}` });
              scrollToBottom();
              break;
            }
          }
        }
      }
    } catch (err: unknown) {
      setMessages((prev) => prev.filter((m) => m.id !== thinkId));
      upsertMsg({
        id: `err-${Date.now()}`,
        kind: "agent",
        text: `⚠️ ${err instanceof Error ? err.message : "Connection error"}`,
      });
      scrollToBottom();
    } finally {
      setBusy(false);
      streamingIdRef.current = null;
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    }
  }, [input, busy, projectId, token, upsertMsg, scrollToBottom, onFilesChanged, profile, queryClient]);

  // ── Render helpers ───────────────────────────────────────────────────────────
  const renderItem = useCallback(
    ({ item }: { item: AgentMsg }) => {
      if (item.kind === "date_divider") {
        return (
          <View style={styles.dateDividerRow}>
            <View style={[styles.dateDividerLine, { backgroundColor: colors.border }]} />
            <Text style={[styles.dateDividerLabel, { color: colors.mutedForeground, backgroundColor: colors.background }]}>
              {item.label}
            </Text>
            <View style={[styles.dateDividerLine, { backgroundColor: colors.border }]} />
          </View>
        );
      }

      if (item.kind === "thinking") {
        return <ThinkingBubble statusText={item.statusText} colors={colors} />;
      }

      if (item.kind === "user") {
        return (
          <View style={styles.userRow}>
            <View style={[styles.userBubble, { backgroundColor: colors.primary }]}>
              <Text style={[styles.bubbleText, { color: "#fff" }]}>{item.text}</Text>
            </View>
          </View>
        );
      }

      if (item.kind === "agent") {
        return (
          <View style={styles.agentRow}>
            <View style={[styles.agentAvatar, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={styles.avatarEmoji}>🤡</Text>
            </View>
            <View style={[styles.agentBubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.bubbleText, { color: colors.foreground }]}>{item.text}</Text>
              {item.streaming && (
                <View style={[styles.cursor, { backgroundColor: colors.primary }]} />
              )}
            </View>
          </View>
        );
      }

      if (item.kind === "tool_call") {
        const done = item.result !== undefined;
        return (
          <View style={styles.toolRow}>
            <View
              style={[
                styles.toolCard,
                {
                  backgroundColor: colors.card,
                  borderColor: done
                    ? item.isError ? colors.destructive + "55" : colors.success + "55"
                    : colors.border,
                },
              ]}
            >
              <View style={styles.toolHeader}>
                <MaterialCommunityIcons
                  name={toolIcon(item.tool) as never}
                  size={14}
                  color={done ? (item.isError ? colors.destructive : colors.success) : colors.mutedForeground}
                />
                <Text style={[styles.toolLabel, { color: colors.mutedForeground }]}>
                  {done ? item.tool.replace("_", " ") : toolLabel(item.tool, item.args)}
                </Text>
                {!done && <ActivityIndicator size="small" color={colors.mutedForeground} style={{ marginLeft: 4 }} />}
                {done && (
                  <MaterialCommunityIcons
                    name={item.isError ? "alert-circle-outline" : "check-circle-outline"}
                    size={13}
                    color={item.isError ? colors.destructive : colors.success}
                    style={{ marginLeft: 4 }}
                  />
                )}
              </View>
              {done && item.result && item.result.length < 400 && (
                <Text
                  style={[styles.toolResult, { color: item.isError ? colors.destructive : colors.mutedForeground }]}
                  numberOfLines={6}
                >
                  {item.result}
                </Text>
              )}
            </View>
          </View>
        );
      }

      return null;
    },
    [colors]
  );

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <KeyboardAvoidingView
        style={[styles.panel, { backgroundColor: colors.background }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Panel header */}
        <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
          <Text style={styles.panelEmoji}>🤡</Text>
          <Text style={[styles.panelTitle, { color: colors.foreground }]}>Agent</Text>
          {busy && <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 8 }} />}

          {/* Inline rename for the active session */}
          {messages.length > 0 && currentSessionId && !busy && (
            editingSessionName ? (
              <TextInput
                ref={sessionNameRef}
                style={[styles.sessionNameInput, { color: colors.foreground, borderColor: colors.primary }]}
                value={sessionNameInput}
                onChangeText={setSessionNameInput}
                onSubmitEditing={commitSessionName}
                onBlur={commitSessionName}
                returnKeyType="done"
                maxLength={80}
                editable={!savingSessionName}
                autoFocus
              />
            ) : (
              <Pressable
                onPress={() => {
                  setSessionNameInput(currentSessionName ?? "");
                  setEditingSessionName(true);
                  setTimeout(() => sessionNameRef.current?.focus(), 50);
                }}
                hitSlop={4}
                style={styles.sessionNameBtn}
              >
                {savingSessionName ? (
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                ) : (
                  <>
                    <Text
                      style={[styles.sessionNameText, { color: currentSessionName ? colors.foreground : colors.mutedForeground }]}
                      numberOfLines={1}
                    >
                      {currentSessionName ?? "Name this chat…"}
                    </Text>
                    <MaterialCommunityIcons name="pencil-outline" size={11} color={colors.mutedForeground} />
                  </>
                )}
              </Pressable>
            )
          )}

          <View style={{ flex: 1 }} />

          {/* New conversation button */}
          <Pressable
            onPress={() => {
              // Only act when there are messages — prevents ghost sessions from
              // being added to pastSessions for empty (never-sent) sessions.
              if (messages.length > 0 && !busy) {
                // Archive current and start fresh
                if (currentSessionId) {
                  const archivedSessionId = currentSessionId;
                  const firstUserMsg = historyRef.current.find((m) => m.role === "user")?.content ?? "";
                  setPastSessions((prev) => [
                    {
                      sessionId: archivedSessionId,
                      name: currentSessionName ?? (firstUserMsg ? autoNameFromMessage(firstUserMsg) : null),
                      preview: firstUserMsg.slice(0, 120),
                      messageCount: messages.filter((m) => m.kind === "user" || m.kind === "agent").length,
                      startedAt: new Date().toISOString(),
                      lastAt: new Date().toISOString(),
                    },
                    ...prev,
                  ]);

                  // Fetch the sessions list in the background so the archived card
                  // shows the server-generated name rather than the locally-derived
                  // fallback (the server may have assigned a name that the client
                  // never received after the initial load).
                  if (token) {
                    const baseUrl = resolveApiBaseUrl();
                    fetch(`${baseUrl}/api/projects/${projectId}/conversations`, {
                      headers: { Authorization: `Bearer ${token}` },
                    })
                      .then((r) => (r.ok ? r.json() : null))
                      .then((sessions: SessionSummary[] | null) => {
                        if (!sessions) return;
                        const match = sessions.find((s) => s.sessionId === archivedSessionId);
                        if (match?.name) {
                          setPastSessions((prev) =>
                            prev.map((s) =>
                              s.sessionId === archivedSessionId ? { ...s, name: match.name } : s,
                            ),
                          );
                        }
                      })
                      .catch(() => {/* non-fatal */});
                  }
                }
                startNewConversation();
              }
              // If messages.length === 0, this is a no-op — nothing to archive.
            }}
            hitSlop={8}
            style={{ padding: 4, marginRight: 2 }}
            disabled={busy}
          >
            <MaterialCommunityIcons
              name="chat-plus-outline"
              size={18}
              color={busy ? colors.mutedForeground + "88" : colors.mutedForeground}
            />
          </Pressable>

          {/* Delete current conversation */}
          {messages.length > 0 && !busy && (
            <Pressable
              onPress={() => {
                Alert.alert(
                  "Delete conversation",
                  "This will delete the current conversation thread. Your code files are not affected.",
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Delete", style: "destructive", onPress: clearConversation },
                  ],
                );
              }}
              hitSlop={8}
              style={{ padding: 4 }}
            >
              <MaterialCommunityIcons name="delete-outline" size={18} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>

        {/* Messages / empty state — single container for all cases */}
        {messages.length === 0 && pastSessions.length === 0 ? (
          /* Truly empty: no messages anywhere — show welcome hints */
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.empty}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.emptyEmoji}>🤡</Text>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Build real apps from your phone</Text>
            <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
              Describe what you want. The agent writes the code, runs it, fixes errors — then you deploy live with one tap.
            </Text>
            <View style={styles.hints}>
              {[
                { icon: "🌐", text: "Build a REST API with Express and deploy it" },
                { icon: "🕷️", text: "Write a Python web scraper for Hacker News" },
                { icon: "📋", text: "Create a full-stack todo app with a database" },
                { icon: "📈", text: "Build a landing page with a waitlist form" },
              ].map(({ icon, text }) => (
                <Pressable
                  key={text}
                  style={[styles.hintChip, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => setInput(text)}
                >
                  <Text style={styles.hintIcon}>{icon}</Text>
                  <Text style={[styles.hintText, { color: colors.foreground }]}>{text}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : (
          /* Active or archived sessions: single FlatList, past sessions in header */
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={messages.length > 0 ? scrollToBottom : undefined}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              pastSessions.length > 0 ? (
                <View style={{ paddingTop: 8, paddingBottom: 4 }}>
                  <Text style={[styles.pastLabel, { color: colors.mutedForeground }]}>
                    Past conversations
                  </Text>
                  {pastSessions.map((s) => (
                    <PastSessionCard
                      key={s.sessionId ?? "legacy"}
                      projectId={projectId}
                      session={s}
                      colors={colors}
                      onRename={(newName) => {
                        setPastSessions((prev) =>
                          prev.map((ps) => ps.sessionId === s.sessionId ? { ...ps, name: newName } : ps)
                        );
                      }}
                      onDelete={() => {
                        Alert.alert(
                          "Delete conversation",
                          "This will permanently delete this conversation thread.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Delete",
                              style: "destructive",
                              onPress: () => deletePastSession(s.sessionId),
                            },
                          ],
                        );
                      }}
                    />
                  ))}
                  {messages.length > 0 && (
                    <>
                      <View style={[styles.sessionDivider, { backgroundColor: colors.border }]} />
                      <Text style={[styles.currentLabel, { color: colors.mutedForeground }]}>
                        Current conversation
                      </Text>
                    </>
                  )}
                </View>
              ) : null
            }
            ListEmptyComponent={
              pastSessions.length > 0 ? (
                <View style={styles.newConvoHint}>
                  <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
                    Tap 💬+ to continue here or start typing below.
                  </Text>
                </View>
              ) : null
            }
          />
        )}

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.chipScroll, { borderTopColor: colors.border }]} contentContainerStyle={styles.chipRow}>
            {attachments.map((a, i) => (
              <View key={i} style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {a.kind === "image"
                  ? <Image source={{ uri: a.preview }} style={styles.chipThumb} />
                  : a.kind === "zip"
                  ? <MaterialCommunityIcons name="folder-zip-outline" size={14} color="#f59e0b" />
                  : <MaterialCommunityIcons name="file-code-outline" size={14} color={colors.primary} />
                }
                <Text style={[styles.chipName, { color: colors.foreground }]} numberOfLines={1}>{a.name}</Text>
                <Pressable onPress={() => removeAttachment(i)} hitSlop={8}>
                  <MaterialCommunityIcons name="close-circle" size={14} color={colors.mutedForeground} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        {/* Picker menu */}
        {pickerOpen && (
          <View style={[styles.pickerMenu, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Pressable style={styles.pickerRow} onPress={pickImage}>
              <MaterialCommunityIcons name="image-outline" size={18} color={colors.primary} />
              <Text style={[styles.pickerLabel, { color: colors.foreground }]}>Photo / Image</Text>
            </Pressable>
            <View style={[styles.pickerDivider, { backgroundColor: colors.border }]} />
            <Pressable style={styles.pickerRow} onPress={pickFile}>
              <MaterialCommunityIcons name="file-outline" size={18} color={colors.primary} />
              <Text style={[styles.pickerLabel, { color: colors.foreground }]}>File or Zip Archive</Text>
            </Pressable>
          </View>
        )}

        {/* Input */}
        <View style={[styles.inputRow, { borderTopColor: colors.border }]}>
          <Pressable
            style={[styles.attachBtn, { borderColor: colors.border, backgroundColor: pickerOpen ? colors.card : "transparent" }]}
            onPress={() => setPickerOpen((v) => !v)}
            disabled={busy}
            hitSlop={4}
          >
            <MaterialCommunityIcons name="paperclip" size={20} color={attachments.length > 0 ? colors.primary : colors.mutedForeground} />
          </Pressable>
          <TextInput
            style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground }]}
            placeholder={busy ? "Agent is working…" : "Describe what to build…"}
            placeholderTextColor={colors.mutedForeground}
            value={input}
            onChangeText={setInput}
            multiline
            maxLength={2000}
            editable={!busy}
            returnKeyType="send"
            onSubmitEditing={() => send()}
            blurOnSubmit
            onFocus={() => setPickerOpen(false)}
          />
          <Pressable
            style={[styles.sendBtn, { backgroundColor: colors.primary, opacity: ((!input.trim() && attachments.length === 0) || busy) ? 0.4 : 1 }]}
            onPress={() => send()}
            disabled={(!input.trim() && attachments.length === 0) || busy}
          >
            {busy
              ? <ActivityIndicator size="small" color="#fff" />
              : <MaterialCommunityIcons name="send" size={18} color="#fff" />
            }
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <PaywallSheet visible={showPaywall} onClose={() => setShowPaywall(false)} reason={paywallReason} />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  panel: {
    flex: 1,
    overflow: "hidden",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 6,
  },
  panelEmoji: { fontSize: 14 },
  panelTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  sessionNameBtn: { flexDirection: "row", alignItems: "center", gap: 3, maxWidth: 160, paddingHorizontal: 4, paddingVertical: 2 },
  sessionNameText: { fontSize: 12, fontFamily: "Inter_400Regular", flexShrink: 1 },
  sessionNameInput: { fontSize: 12, fontFamily: "Inter_400Regular", borderBottomWidth: 1, paddingVertical: 1, paddingHorizontal: 2, minWidth: 80, maxWidth: 180 },

  listContent: { padding: 10, gap: 8 },

  // Thinking
  thinkRow: { alignItems: "flex-start", paddingLeft: 4 },
  thinkBubble: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1,
  },
  thinkText: { fontSize: 13 },

  // User
  userRow: { alignItems: "flex-end" },
  userBubble: {
    maxWidth: "80%", paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18, borderBottomRightRadius: 4,
  },

  // Agent
  agentRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, maxWidth: "88%" },
  agentAvatar: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 1,
    alignItems: "center", justifyContent: "center", marginTop: 2,
  },
  avatarEmoji: { fontSize: 14 },
  agentBubble: {
    flex: 1, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 16, borderBottomLeftRadius: 4, borderWidth: 1,
  },
  cursor: { width: 2, height: 14, borderRadius: 1, marginTop: 2 },

  // Tool
  toolRow: { paddingLeft: 34 },
  toolCard: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, gap: 4 },
  toolHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  toolLabel: { fontSize: 12, flex: 1 },
  toolResult: { fontSize: 11, fontFamily: "monospace", marginTop: 2 },

  bubbleText: { fontSize: 13, lineHeight: 19 },

  // Past sessions
  pastLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.8, paddingHorizontal: 14, paddingBottom: 6 },
  currentLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.8, paddingHorizontal: 14, paddingBottom: 4, paddingTop: 8 },
  sessionDivider: { height: 1, marginHorizontal: 14, marginTop: 8 },

  // Empty state
  empty: { alignItems: "center", justifyContent: "center", padding: 20, gap: 10 },
  emptyEmoji: { fontSize: 36 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_700Bold", textAlign: "center" },
  emptySubtitle: { fontSize: 12, textAlign: "center", lineHeight: 18 },
  hints: { gap: 6, width: "100%", marginTop: 4 },
  hintChip: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 10, borderWidth: 1,
  },
  hintIcon: { fontSize: 14 },
  hintText: { fontSize: 12, flex: 1 },

  // Input
  inputRow: {
    flexDirection: "row", alignItems: "flex-end", gap: 8,
    paddingHorizontal: 10, paddingBottom: 10, paddingTop: 8,
    borderTopWidth: 1,
  },
  attachBtn: {
    width: 34, height: 34, borderRadius: 10, borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  input: {
    flex: 1, borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 13, maxHeight: 100,
  },
  sendBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: "center", justifyContent: "center",
  },

  // Attachment chips
  chipScroll: { maxHeight: 52, borderTopWidth: 1 },
  chipRow: { flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingVertical: 8, alignItems: "center" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    borderWidth: 1, borderRadius: 20,
    paddingLeft: 4, paddingRight: 8, paddingVertical: 4, maxWidth: 160,
  },
  chipThumb: { width: 22, height: 22, borderRadius: 4 },
  chipName: { fontSize: 11, flex: 1 },

  // Date divider
  dateDividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 6, paddingHorizontal: 4 },
  dateDividerLine: { flex: 1, height: 1 },
  dateDividerLabel: { fontSize: 11, fontFamily: "Inter_400Regular", paddingHorizontal: 10 },

  // New conversation hint (shown in FlatList empty state when past sessions exist)
  newConvoHint: { alignItems: "center", paddingVertical: 20, paddingHorizontal: 24 },

  // Picker menu
  pickerMenu: { marginHorizontal: 10, marginBottom: 4, borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  pickerLabel: { fontSize: 14 },
  pickerDivider: { height: 1, marginHorizontal: 14 },
});
