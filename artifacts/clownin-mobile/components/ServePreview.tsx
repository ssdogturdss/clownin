/**
 * ServePreview — embeds a live server's proxy URL in a WebView.
 * Falls back to a URL card on Expo web where WebView is unavailable.
 *
 * Reload is triggered by changing the `reloadKey` prop (forces remount).
 */
import React from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface ServePreviewProps {
  url: string;
  /** Increment to force a full reload of the embedded preview. */
  reloadKey?: number;
}

export function ServePreview({ url, reloadKey = 0 }: ServePreviewProps) {
  if (Platform.OS === "web") {
    return (
      <View style={styles.fallback}>
        <Ionicons name="globe-outline" size={36} color="#3fb950" />
        <Text style={styles.fallbackTitle}>Server is live</Text>
        <Pressable style={styles.openBtn} onPress={() => Linking.openURL(url)}>
          <Text style={styles.openBtnText}>Open in browser</Text>
          <Ionicons name="open-outline" size={14} color="#fff" />
        </Pressable>
        <Text style={styles.fallbackUrl} numberOfLines={2}>{url}</Text>
      </View>
    );
  }

  // Dynamic import keeps react-native-webview out of the web bundle
  // and avoids TypeScript overload conflicts on web-targeting configs.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebView } = require("react-native-webview") as { WebView: React.ComponentType<Record<string, unknown>> };

  return (
    <WebView
      key={reloadKey}
      source={{ uri: url }}
      style={styles.webview}
      startInLoadingState
      renderLoading={() => (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#3fb950" />
          <Text style={styles.loadingText}>Loading preview…</Text>
        </View>
      )}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: "#fff" },
  loading: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#0a0f14",
  },
  loadingText: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#8b949e" },
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 24,
    backgroundColor: "#0a0f14",
  },
  fallbackTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#3fb950" },
  fallbackUrl: {
    fontSize: 11,
    color: "#8b949e",
    fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace",
    textAlign: "center",
  },
  openBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#238636",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  openBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
