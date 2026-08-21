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
  url?: string | null;
  isStarting?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Increment to force a full reload of the embedded preview. */
  reloadKey?: number;
}

export function ServePreview({ url, isStarting = false, error = null, onRetry, reloadKey = 0 }: ServePreviewProps) {
  const [loaded, setLoaded] = React.useState(false);
  const [webViewError, setWebViewError] = React.useState<string | null>(null);
  const displayError = error ?? webViewError;

  if (isStarting) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#3fb950" />
        <Text style={styles.loadingTitle}>Starting live preview</Text>
        <Text style={styles.loadingText}>Your server is coming online. This can take a few seconds.</Text>
      </View>
    );
  }

  if (displayError) {
    return (
      <View style={styles.loading}>
        <Ionicons name="alert-circle-outline" size={36} color="#f85149" />
        <Text style={styles.loadingTitle}>Preview couldn’t start</Text>
        <Text style={styles.loadingText}>{displayError}</Text>
        {onRetry && (
          <Pressable style={styles.openBtn} onPress={onRetry}>
            <Ionicons name="refresh-outline" size={14} color="#fff" />
            <Text style={styles.openBtnText}>Try again</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (!url) return null;

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
    <View style={styles.webviewContainer}>
      {!loaded && (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#3fb950" />
          <Text style={styles.loadingText}>Loading live preview…</Text>
        </View>
      )}
      <WebView
        key={reloadKey}
        source={{ uri: url }}
        style={[styles.webview, !loaded && styles.hiddenWebview]}
        onLoadStart={() => { setLoaded(false); setWebViewError(null); }}
        onLoad={() => setLoaded(true)}
        onError={() => setWebViewError("The preview connection was lost. Try starting it again.")}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: "#fff" },
  webviewContainer: { flex: 1, backgroundColor: "#0a0f14" },
  hiddenWebview: { opacity: 0 },
  loading: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#0a0f14",
  },
  loadingTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#e6edf3", textAlign: "center" },
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
