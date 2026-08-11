/**
 * App Store screenshot — 5.5" iPhone (1242×2208)
 * Viewport must be set to 1242×2208 when screenshotting.
 * Screen: Project editor + AI chat
 */
export default function Screenshot55() {
  const files = ["index.js", "routes.js", "db.js", "README.md"];

  const codeLines = [
    { tokens: [{ t: "const", c: "#ff7b72" }, { t: " express", c: "#e6edf3" }, { t: " = ", c: "#e6edf3" }, { t: "require", c: "#d2a8ff" }, { t: "('express')", c: "#a5d6ff" }] },
    { tokens: [{ t: "const", c: "#ff7b72" }, { t: " app", c: "#e6edf3" }, { t: " = ", c: "#e6edf3" }, { t: "express()", c: "#d2a8ff" }] },
    { tokens: [] },
    { tokens: [{ t: "// GET /workouts — returns all sessions", c: "#8b949e" }] },
    { tokens: [{ t: "app", c: "#e6edf3" }, { t: ".", c: "#e6edf3" }, { t: "get", c: "#d2a8ff" }, { t: "('/workouts',", c: "#a5d6ff" }, { t: " async ", c: "#ff7b72" }, { t: "(req, res)", c: "#e6edf3" }, { t: " => {", c: "#e6edf3" }] },
    { tokens: [{ t: "  const", c: "#ff7b72" }, { t: " rows", c: "#e6edf3" }, { t: " = ", c: "#e6edf3" }, { t: "await ", c: "#ff7b72" }, { t: "db", c: "#e6edf3" }, { t: ".query(", c: "#d2a8ff" }, { t: "'SELECT * FROM…'", c: "#a5d6ff" }, { t: ")", c: "#e6edf3" }] },
    { tokens: [{ t: "  res", c: "#e6edf3" }, { t: ".json(rows)", c: "#d2a8ff" }] },
    { tokens: [{ t: "})", c: "#e6edf3" }] },
    { tokens: [] },
    { tokens: [{ t: "app", c: "#e6edf3" }, { t: ".listen(", c: "#d2a8ff" }, { t: "3000", c: "#79c0ff" }, { t: ", () =>", c: "#e6edf3" }] },
    { tokens: [{ t: "  console", c: "#e6edf3" }, { t: ".log(", c: "#d2a8ff" }, { t: "'Server ready'", c: "#a5d6ff" }, { t: "))", c: "#e6edf3" }] },
  ];

  return (
    <div
      style={{
        width: 1242,
        height: 2208,
        background: "#0d1117",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 48px",
          flexShrink: 0,
          background: "#0d1117",
        }}
      >
        <span style={{ color: "#e6edf3", fontSize: 30, fontWeight: 600 }}>9:41</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <svg width="40" height="24" viewBox="0 0 40 24" fill="none">
            <rect x="0" y="14" width="7" height="10" rx="2" fill="#e6edf3" />
            <rect x="10" y="8" width="7" height="16" rx="2" fill="#e6edf3" />
            <rect x="20" y="3" width="7" height="21" rx="2" fill="#e6edf3" />
            <rect x="30" y="0" width="7" height="24" rx="2" fill="#e6edf3" />
          </svg>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ width: 46, height: 22, border: "2px solid #e6edf3", borderRadius: 5, padding: 2 }}>
              <div style={{ width: "80%", height: "100%", background: "#e6edf3", borderRadius: 2 }} />
            </div>
            <div style={{ width: 3, height: 10, background: "#e6edf3", borderRadius: "0 2px 2px 0", marginLeft: 1 }} />
          </div>
        </div>
      </div>

      {/* Top nav */}
      <div
        style={{
          height: 88,
          background: "#161b22",
          borderBottom: "1.5px solid #30363d",
          display: "flex",
          alignItems: "center",
          padding: "0 40px",
          gap: 24,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 28, color: "#8b949e" }}>←</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 30, fontWeight: 700, color: "#e6edf3" }}>Workout Tracker API</div>
          <div style={{ fontSize: 22, color: "#8b949e" }}>index.js • JavaScript</div>
        </div>
        {/* Action icons */}
        {["▶", "🤡", "⬆"].map((icon, i) => (
          <div
            key={i}
            style={{
              width: 68,
              height: 68,
              background: icon === "🤡" ? "#FF6B35" : "#21262d",
              borderRadius: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: icon === "🤡" ? 36 : 28,
              color: icon === "🤡" ? "#0d1117" : "#e6edf3",
              border: icon === "🤡" ? "none" : "1.5px solid #30363d",
            }}
          >
            {icon}
          </div>
        ))}
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "row", overflow: "hidden" }}>
        {/* File sidebar */}
        <div
          style={{
            width: 220,
            background: "#161b22",
            borderRight: "1.5px solid #30363d",
            display: "flex",
            flexDirection: "column",
            padding: "20px 0",
          }}
        >
          <div style={{ fontSize: 22, color: "#8b949e", padding: "0 24px 16px", fontWeight: 600, letterSpacing: 1 }}>
            FILES
          </div>
          {files.map((f, i) => (
            <div
              key={f}
              style={{
                padding: "18px 24px",
                background: i === 0 ? "#21262d" : "transparent",
                borderLeft: i === 0 ? "3px solid #FF6B35" : "3px solid transparent",
                fontSize: 26,
                color: i === 0 ? "#e6edf3" : "#8b949e",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 22 }}>{f.endsWith(".md") ? "📄" : f.endsWith(".js") ? "🟨" : "📄"}</span>
              {f}
            </div>
          ))}
        </div>

        {/* Code editor */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {/* Code content */}
          <div style={{ flex: 1, padding: "28px 0", background: "#0d1117" }}>
            {codeLines.map((line, li) => (
              <div
                key={li}
                style={{ display: "flex", minHeight: 44, alignItems: "center" }}
              >
                <div
                  style={{
                    width: 72,
                    textAlign: "right",
                    paddingRight: 24,
                    fontSize: 26,
                    color: "#3c4452",
                    flexShrink: 0,
                  }}
                >
                  {li + 1}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap" }}>
                  {line.tokens.map((tok, ti) => (
                    <span key={ti} style={{ fontSize: 28, color: tok.c, fontFamily: "'Fira Code', 'Courier New', monospace" }}>
                      {tok.t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Terminal strip */}
          <div
            style={{
              height: 200,
              background: "#0d1117",
              borderTop: "1.5px solid #30363d",
              padding: "20px 32px",
            }}
          >
            <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
              <span style={{ fontSize: 24, color: "#8b949e", fontWeight: 600 }}>TERMINAL</span>
              <span style={{ fontSize: 24, color: "#8b949e" }}>OUTPUT</span>
            </div>
            <div style={{ fontSize: 26, color: "#3fb950", fontFamily: "'Fira Code', monospace" }}>
              $ node index.js
            </div>
            <div style={{ fontSize: 26, color: "#e6edf3", fontFamily: "'Fira Code', monospace" }}>
              Server ready on port 3000 ✓
            </div>
          </div>
        </div>
      </div>

      {/* AI Chat panel */}
      <div
        style={{
          height: 740,
          background: "#161b22",
          borderTop: "2px solid #FF6B35",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        {/* Chat header */}
        <div
          style={{
            padding: "24px 40px",
            borderBottom: "1.5px solid #30363d",
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <span style={{ fontSize: 36 }}>🤡</span>
          <span style={{ fontSize: 30, fontWeight: 700, color: "#e6edf3" }}>AI Assistant</span>
          <div style={{ marginLeft: "auto", background: "#21262d", borderRadius: 100, padding: "8px 24px", fontSize: 22, color: "#FF6B35" }}>
            4 messages left today
          </div>
        </div>

        {/* Chat messages */}
        <div style={{ flex: 1, padding: "24px 40px", display: "flex", flexDirection: "column", gap: 20 }}>
          {/* User message */}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <div
              style={{
                background: "#FF6B35",
                borderRadius: "20px 20px 4px 20px",
                padding: "20px 32px",
                maxWidth: "80%",
              }}
            >
              <div style={{ fontSize: 28, color: "#0d1117", fontWeight: 500 }}>
                Add a POST /workouts endpoint that saves a new session
              </div>
            </div>
          </div>

          {/* AI message */}
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            <div
              style={{
                width: 52,
                height: 52,
                background: "#FF6B35",
                borderRadius: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 30,
                flexShrink: 0,
              }}
            >
              🤡
            </div>
            <div
              style={{
                background: "#21262d",
                borderRadius: "4px 20px 20px 20px",
                padding: "20px 32px",
                border: "1.5px solid #30363d",
                flex: 1,
              }}
            >
              <div style={{ fontSize: 28, color: "#e6edf3", lineHeight: 1.5 }}>
                I'll add the POST endpoint with input validation and write it to{" "}
                <span style={{ color: "#FF6B35", fontFamily: "monospace" }}>routes.js</span>. Done!
              </div>
              {/* Tool call card */}
              <div
                style={{
                  marginTop: 20,
                  background: "#0d1117",
                  border: "1.5px solid #30363d",
                  borderRadius: 12,
                  padding: "16px 24px",
                  display: "flex",
                  gap: 16,
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 26, color: "#3fb950" }}>✓</span>
                <span style={{ fontSize: 24, color: "#8b949e" }}>write_file</span>
                <span style={{ fontSize: 24, color: "#e6edf3", marginLeft: 8 }}>routes.js</span>
              </div>
            </div>
          </div>
        </div>

        {/* Chat input */}
        <div
          style={{
            padding: "20px 40px",
            borderTop: "1.5px solid #30363d",
            display: "flex",
            gap: 20,
            alignItems: "center",
          }}
        >
          <div
            style={{
              flex: 1,
              background: "#21262d",
              borderRadius: 16,
              border: "1.5px solid #30363d",
              padding: "22px 32px",
              fontSize: 28,
              color: "#8b949e",
            }}
          >
            Ask the AI to change something…
          </div>
          <div
            style={{
              width: 72,
              height: 72,
              background: "#FF6B35",
              borderRadius: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
              color: "#0d1117",
            }}
          >
            ↑
          </div>
        </div>

        {/* Home indicator */}
        <div style={{ height: 48, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 160, height: 6, background: "#8b949e", borderRadius: 3 }} />
        </div>
      </div>
    </div>
  );
}
