/**
 * App Store screenshot — 6.7" iPhone (1290×2796)
 * Viewport must be set to 1290×2796 when screenshotting.
 * Screen: Onboarding / hero
 */
export default function Screenshot67() {
  return (
    <div
      style={{
        width: 1290,
        height: 2796,
        background: "#0d1117",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          height: 54,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 52px",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#e6edf3", fontSize: 34, fontWeight: 600 }}>
          9:41
        </span>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {/* Signal */}
          <svg width="48" height="28" viewBox="0 0 48 28" fill="none">
            <rect x="0" y="16" width="8" height="12" rx="2" fill="#e6edf3" />
            <rect x="11" y="10" width="8" height="18" rx="2" fill="#e6edf3" />
            <rect x="22" y="4" width="8" height="24" rx="2" fill="#e6edf3" />
            <rect x="33" y="0" width="8" height="28" rx="2" fill="#e6edf3" />
          </svg>
          {/* WiFi */}
          <svg width="40" height="28" viewBox="0 0 40 28" fill="none">
            <path d="M20 22 C 20 22 20 22 20 22" stroke="#e6edf3" strokeWidth="4" strokeLinecap="round" />
            <path d="M13 16 Q 20 10 27 16" stroke="#e6edf3" strokeWidth="3.5" strokeLinecap="round" fill="none" />
            <path d="M6 10 Q 20 0 34 10" stroke="#e6edf3" strokeWidth="3.5" strokeLinecap="round" fill="none" />
          </svg>
          {/* Battery */}
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <div style={{ width: 52, height: 26, border: "2.5px solid #e6edf3", borderRadius: 6, padding: 3 }}>
              <div style={{ width: "80%", height: "100%", background: "#e6edf3", borderRadius: 3 }} />
            </div>
            <div style={{ width: 4, height: 12, background: "#e6edf3", borderRadius: "0 2px 2px 0", marginLeft: 1 }} />
          </div>
        </div>
      </div>

      {/* Hero section */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "60px 80px 0",
        }}
      >
        {/* Logo */}
        <div
          style={{
            width: 160,
            height: 160,
            background: "linear-gradient(135deg, #FF6B35 0%, #ff8c5a 100%)",
            borderRadius: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 48,
            boxShadow: "0 20px 60px rgba(255,107,53,0.4)",
          }}
        >
          <span style={{ fontSize: 90, lineHeight: 1 }}>🤡</span>
        </div>

        {/* App name */}
        <div
          style={{
            fontSize: 88,
            fontWeight: 800,
            color: "#e6edf3",
            letterSpacing: -3,
            marginBottom: 20,
          }}
        >
          Clownin
        </div>
        <div
          style={{
            fontSize: 44,
            color: "#FF6B35",
            fontWeight: 600,
            letterSpacing: -1,
            marginBottom: 16,
            textAlign: "center",
          }}
        >
          Build real apps from your phone
        </div>
        <div
          style={{
            fontSize: 36,
            color: "#8b949e",
            textAlign: "center",
            lineHeight: 1.5,
            maxWidth: 800,
            marginBottom: 80,
          }}
        >
          Describe what you want to build. AI writes the code, runs it, and fixes the bugs — all from your pocket.
        </div>

        {/* Prompt input */}
        <div
          style={{
            width: "100%",
            background: "#161b22",
            border: "2px solid #FF6B35",
            borderRadius: 24,
            padding: "40px 52px",
            marginBottom: 40,
          }}
        >
          <div style={{ fontSize: 36, color: "#8b949e", marginBottom: 24 }}>What do you want to build?</div>
          <div style={{ fontSize: 40, color: "#e6edf3", lineHeight: 1.4 }}>
            Build me a REST API that tracks workouts and returns weekly stats 💪
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 32,
            }}
          >
            <div
              style={{
                background: "#FF6B35",
                borderRadius: 16,
                padding: "20px 48px",
                fontSize: 36,
                fontWeight: 700,
                color: "#0d1117",
              }}
            >
              Generate →
            </div>
          </div>
        </div>

        {/* Preset chips */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, justifyContent: "center", marginBottom: 72 }}>
          {["Express REST API", "Python scraper", "Full-stack todo", "Landing page"].map((label) => (
            <div
              key={label}
              style={{
                background: "#21262d",
                border: "1.5px solid #30363d",
                borderRadius: 100,
                padding: "18px 36px",
                fontSize: 30,
                color: "#e6edf3",
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Feature pills */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28, width: "100%" }}>
          {[
            { icon: "⚡", label: "AI writes & runs your code instantly" },
            { icon: "🚀", label: "Deploy to Netlify, Vercel, or GitHub" },
            { icon: "🛠", label: "Real terminal — Python, JS, TypeScript" },
          ].map(({ icon, label }) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 32,
                background: "#161b22",
                border: "1.5px solid #30363d",
                borderRadius: 20,
                padding: "32px 44px",
              }}
            >
              <span style={{ fontSize: 48 }}>{icon}</span>
              <span style={{ fontSize: 34, color: "#e6edf3", fontWeight: 500 }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom gradient fade */}
      <div
        style={{
          height: 200,
          background: "linear-gradient(transparent, #0d1117)",
          flexShrink: 0,
        }}
      />

      {/* Home indicator */}
      <div
        style={{
          height: 68,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <div style={{ width: 200, height: 8, background: "#8b949e", borderRadius: 4 }} />
      </div>
    </div>
  );
}
