/**
 * InAppPreview — renders an HTML file inside a WebView modal.
 * No deploy token needed: instant gratification for HTML projects.
 */
import React, { useMemo } from "react";
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  Platform,
} from "react-native";
import { WebView } from "react-native-webview";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

interface InAppPreviewProps {
  visible: boolean;
  onClose: () => void;
  /** The HTML string to render */
  html: string;
  /** File name shown in the header */
  fileName: string;
}

export function InAppPreview({ visible, onClose, html, fileName }: InAppPreviewProps) {
  const colors = useColors();

  // Inject a base tag so relative paths resolve, and a meta viewport
  const injected = useMemo(() => {
    const hasMeta = /<meta[^>]*viewport/i.test(html);
    const hasBase = /<base/i.test(html);
    const inject = [
      !hasMeta ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : "",
      !hasBase ? '<base href="about:blank">' : "",
    ].join("");

    if (/<head/i.test(html)) {
      return html.replace(/<head[^>]*>/i, (m) => `${m}${inject}`);
    }
    return `<!DOCTYPE html><html><head>${inject}</head><body>${html}</body></html>`;
  }, [html]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <MaterialCommunityIcons name="eye-outline" size={18} color={colors.primary} />
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {fileName}
          </Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <MaterialCommunityIcons name="close" size={20} color={colors.mutedForeground} />
          </Pressable>
        </View>

        {/* WebView */}
        {Platform.OS === "web" ? (
          // On web, use an iframe via dangerouslySetInnerHTML workaround
          <View style={styles.webFallback}>
            <MaterialCommunityIcons name="monitor" size={40} color={colors.mutedForeground} />
            <Text style={[styles.webFallbackText, { color: colors.mutedForeground }]}>
              Open in the Expo Go app to preview HTML output.
            </Text>
          </View>
        ) : (
          <WebView
            style={styles.webview}
            source={{ html: injected }}
            originWhitelist={["*"]}
            javaScriptEnabled
            domStorageEnabled
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: 15, fontWeight: "600" },
  webview: { flex: 1 },
  webFallback: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  webFallbackText: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
