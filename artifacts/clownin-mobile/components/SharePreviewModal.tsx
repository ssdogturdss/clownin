import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Modal,
  ActivityIndicator,
  StyleSheet,
  Share,
  Alert,
  Platform,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useEnablePreview } from "@workspace/api-client-react";
import { resolveApiBaseUrl } from "@/app/_layout";

interface SharePreviewModalProps {
  visible: boolean;
  onClose: () => void;
  projectId: number;
  projectName: string;
  /** True when the project has at least one HTML file */
  hasHtmlFile: boolean;
  onOpenDeploy: () => void;
}

export function SharePreviewModal({
  visible,
  onClose,
  projectId,
  projectName,
  hasHtmlFile,
  onOpenDeploy,
}: SharePreviewModalProps) {
  const colors = useColors();
  const enablePreviewMutation = useEnablePreview();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (!visible) {
      // Reset state when modal closes
      setPreviewUrl(null);
      setShared(false);
      return;
    }
    if (!hasHtmlFile) return;

    // Auto-enable preview when modal opens (idempotent on the server)
    enablePreviewMutation.mutate(
      { id: projectId },
      {
        onSuccess(data) {
          const base = resolveApiBaseUrl() ?? "";
          const url = `${base}/preview/${data.shortId}`;
          setPreviewUrl(url);
        },
        onError() {
          Alert.alert("Error", "Could not generate preview link. Please try again.");
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectId, hasHtmlFile]);

  const handleShare = async () => {
    if (!previewUrl) return;
    try {
      await Share.share(
        {
          message: Platform.OS === "ios" ? undefined : previewUrl,
          url: previewUrl, // iOS uses url; android falls back to message
          title: `${projectName} — Built with Synthetic Solutions Clownin Edition 🤡`,
        },
        { subject: `${projectName} — Built with Synthetic Solutions Clownin Edition 🤡` },
      );
      setShared(true);
    } catch {
      // User dismissed share sheet — no-op
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          onPress={() => {}}
        >
          {/* Handle bar */}
          <View style={[styles.handle, { backgroundColor: colors.border }]} />

          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              Share Preview 🔗
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.mutedForeground} />
            </Pressable>
          </View>

          {hasHtmlFile ? (
            <HtmlShareContent
              colors={colors}
              previewUrl={previewUrl}
              loading={enablePreviewMutation.isPending}
              shared={shared}
              onShare={handleShare}
            />
          ) : (
            <NonHtmlContent
              colors={colors}
              onClose={onClose}
              onOpenDeploy={onOpenDeploy}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── HTML share content ───────────────────────────────────────────────────────

function HtmlShareContent({
  colors,
  previewUrl,
  loading,
  shared,
  onShare,
}: {
  colors: ReturnType<typeof useColors>;
  previewUrl: string | null;
  loading: boolean;
  shared: boolean;
  onShare: () => void;
}) {
  return (
    <View style={styles.content}>
      <View style={[styles.iconCircle, { backgroundColor: colors.primary + "18" }]}>
        <MaterialCommunityIcons name="web" size={32} color={colors.primary} />
      </View>

      <Text style={[styles.body, { color: colors.mutedForeground }]}>
        Your HTML project gets a public live preview anyone can open in their browser — no login required.
      </Text>

      {loading ? (
        <View style={styles.urlRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.urlText, { color: colors.mutedForeground }]}>
            Generating link…
          </Text>
        </View>
      ) : previewUrl ? (
        <View
          style={[
            styles.urlBox,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <MaterialCommunityIcons
            name="link-variant"
            size={15}
            color={colors.primary}
          />
          <Text
            style={[styles.urlText, { color: colors.foreground }]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {previewUrl}
          </Text>
        </View>
      ) : null}

      <Pressable
        style={[
          styles.shareBtn,
          {
            backgroundColor: shared ? colors.muted : colors.primary,
            borderColor: shared ? colors.border : colors.primary,
            opacity: loading || !previewUrl ? 0.5 : 1,
          },
        ]}
        onPress={onShare}
        disabled={loading || !previewUrl}
      >
        <Ionicons
          name={shared ? "checkmark" : "share-outline"}
          size={18}
          color={shared ? colors.foreground : colors.primaryForeground}
        />
        <Text
          style={[
            styles.shareBtnText,
            { color: shared ? colors.foreground : colors.primaryForeground },
          ]}
        >
          {shared ? "Link shared!" : "Share link"}
        </Text>
      </Pressable>

      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        The link shows the latest saved version of your HTML file with a "Built with Synthetic Solutions Clownin Edition 🤡" badge.
      </Text>
    </View>
  );
}

// ─── Non-HTML (server project) content ───────────────────────────────────────

function NonHtmlContent({
  colors,
  onClose,
  onOpenDeploy,
}: {
  colors: ReturnType<typeof useColors>;
  onClose: () => void;
  onOpenDeploy: () => void;
}) {
  return (
    <View style={styles.content}>
      <View style={[styles.iconCircle, { backgroundColor: colors.muted }]}>
        <MaterialCommunityIcons
          name="rocket-launch-outline"
          size={32}
          color={colors.mutedForeground}
        />
      </View>

      <Text style={[styles.bodyLarge, { color: colors.foreground }]}>
        Server projects need deployment
      </Text>

      <Text style={[styles.body, { color: colors.mutedForeground }]}>
        Live preview links work for HTML projects. For Node or Python projects, deploy first — then you'll get a shareable production URL.
      </Text>

      <Pressable
        style={[
          styles.shareBtn,
          { backgroundColor: colors.primary, borderColor: colors.primary },
        ]}
        onPress={() => {
          onClose();
          onOpenDeploy();
        }}
      >
        <MaterialCommunityIcons
          name="rocket-launch-outline"
          size={18}
          color={colors.primaryForeground}
        />
        <Text style={[styles.shareBtnText, { color: colors.primaryForeground }]}>
          Go to Deploy
        </Text>
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingBottom: 40,
    paddingHorizontal: 20,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  content: {
    alignItems: "center",
    paddingTop: 8,
    gap: 14,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  bodyLarge: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  body: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 4,
  },
  urlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginVertical: 4,
  },
  urlBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignSelf: "stretch",
  },
  urlText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 24,
    borderWidth: 1,
    alignSelf: "stretch",
    marginTop: 4,
  },
  shareBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 17,
    paddingHorizontal: 8,
  },
});
