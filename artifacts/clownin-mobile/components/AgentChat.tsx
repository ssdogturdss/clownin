import React, { useRef, useState, useCallback } from "react";
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
  | { kind: "text"; name: string; content: string };

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
};

type ThinkingMsg = { id: string; kind: "thinking" };

type AgentMsg = TextMsg | ToolCallMsg | ThinkingMsg;

// Pair sent to backend as history
type HistoryEntry = { role: "user" | "assistant"; content: string };

// ── Tool label helpers ────────────────────────────────────────────────────────
function toolLabel(tool: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  switch (tool) {
    case "list_files":      return "Listing files…";
    case "read_file":       return `Reading ${path}`;
    case "write_file":      return `Writing ${path}`;
    case "create_file":     return `Creating ${path}`;
    case "delete_file":     return `Deleting ${path}`;
    case "run_code":        return `Running ${path}`;
    case "install_packages": {
      const pkgs = Array.isArray(args.packages) ? (args.packages as string[]).join(", ") : "";
      return `Installing ${pkgs}`;
    }
    case "enable_preview":  return "Generating preview link…";
    case "deploy": {
      const platform = typeof args.platform === "string" ? args.platform : "hosting";
      return `Deploying to ${platform}…`;
    }
    default:                return tool;
  }
}

function toolIcon(tool: string): string {
  switch (tool) {
    case "list_files":       return "format-list-bulleted";
    case "read_file":        return "file-eye-outline";
    case "write_file":
    case "create_file":      return "file-edit-outline";
    case "delete_file":      return "file-remove-outline";
    case "run_code":         return "play-circle-outline";
    case "install_packages": return "package-down";
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

  const { data: profile } = useProfile();
  const queryClient = useQueryClient();

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

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
      const content = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'utf8' });
      setAttachments((prev) => [...prev, { kind: "text", name: asset.name, content }]);
    } catch {
      Alert.alert("Could not read file", "Only plain text and code files are supported.");
    }
  }, []);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Auto-send initialMessage once on mount
  React.useEffect(() => {
    if (!initialMessage || autoSentRef.current) return;
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
              : { kind: "text", name: a.name, content: a.content }
          ),
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

            case "error": {
              removeThinking();
              const { message: errMsg } = event.payload as { message: string };
              upsertMsg({ id: `err-${Date.now()}`, kind: "agent", text: `⚠️ ${errMsg}` });
              scrollToBottom();
              break;
            }

            case "done":
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
              break;
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
      if (item.kind === "thinking") {
        return (
          <View style={[styles.thinkRow]}>
            <View style={[styles.thinkBubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.thinkText, { color: colors.mutedForeground }]}>thinking…</Text>
            </View>
          </View>
        );
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
        </View>

        {/* Messages / empty state */}
        {messages.length === 0 ? (
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
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={scrollToBottom}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          />
        )}

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.chipScroll, { borderTopColor: colors.border }]} contentContainerStyle={styles.chipRow}>
            {attachments.map((a, i) => (
              <View key={i} style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {a.kind === "image"
                  ? <Image source={{ uri: a.preview }} style={styles.chipThumb} />
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
              <Text style={[styles.pickerLabel, { color: colors.foreground }]}>Text / Code File</Text>
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

  // Picker menu
  pickerMenu: { marginHorizontal: 10, marginBottom: 4, borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  pickerLabel: { fontSize: 14 },
  pickerDivider: { height: 1, marginHorizontal: 14 },
});
