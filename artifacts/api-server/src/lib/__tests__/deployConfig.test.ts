import { describe, it, expect } from "vitest";
import {
  detectType,
  generateContainerFiles,
  type FileEntry,
} from "../deployConfig";

// ─── detectType ──────────────────────────────────────────────────────────────

describe("detectType", () => {
  it("classifies Flask app as python-server even when HTML templates are present", () => {
    const files: FileEntry[] = [
      { path: "app.py", content: "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef index(): return 'hi'" },
      { path: "templates/index.html", content: "<html><body>hi</body></html>" },
    ];
    expect(detectType(files)).toBe("python-server");
  });

  it("classifies FastAPI app as python-server", () => {
    const files: FileEntry[] = [
      { path: "main.py", content: "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/')\ndef root(): return {}" },
    ];
    expect(detectType(files)).toBe("python-server");
  });

  it("classifies Express app as node-server even when HTML files are present", () => {
    const files: FileEntry[] = [
      { path: "index.js", content: "const express = require('express');\nconst app = express();\napp.listen(3000);" },
      { path: "public/index.html", content: "<html></html>" },
    ];
    expect(detectType(files)).toBe("node-server");
  });

  it("classifies plain HTML project as static", () => {
    const files: FileEntry[] = [
      { path: "index.html", content: "<html><body>hello</body></html>" },
      { path: "style.css", content: "body { margin: 0; }" },
    ];
    expect(detectType(files)).toBe("static");
  });

  it("classifies TypeScript Express server as node-server", () => {
    const files: FileEntry[] = [
      { path: "server.ts", content: "import express from 'express';\nconst app = express();\napp.listen(3000);" },
    ];
    expect(detectType(files)).toBe("node-server");
  });

  it("classifies bare Python file as python-script", () => {
    const files: FileEntry[] = [
      { path: "scraper.py", content: "import requests\nprint(requests.get('https://example.com').text)" },
    ];
    expect(detectType(files)).toBe("python-script");
  });

  it("classifies bare JS file as node-script", () => {
    const files: FileEntry[] = [
      { path: "script.js", content: "console.log('hello world');" },
    ];
    expect(detectType(files)).toBe("node-script");
  });
});

// ─── generateContainerFiles ──────────────────────────────────────────────────

describe("generateContainerFiles — Flask without requirements.txt", () => {
  const files: FileEntry[] = [
    { path: "app.py", content: "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef index(): return 'hi'" },
  ];

  it("marks the project as container-ready", () => {
    const { isContainerReady } = generateContainerFiles(files);
    expect(isContainerReady).toBe(true);
  });

  it("generates a Dockerfile that uses gunicorn with dynamic PORT", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df).toBeDefined();
    expect(df.content).toContain("gunicorn");
    // Shell form CMD so $PORT is expanded at runtime
    expect(df.content).toContain("0.0.0.0:${PORT:-8000}");
  });

  it("Dockerfile does not use COPY requirements.txt* (fails when absent)", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).not.toContain("COPY requirements.txt*");
  });

  it("Dockerfile uses COPY . . before conditional pip install", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    const copyDotIdx = df.content.indexOf("COPY . .");
    const pipIdx = df.content.indexOf("pip install");
    expect(copyDotIdx).toBeGreaterThanOrEqual(0);
    expect(pipIdx).toBeGreaterThan(copyDotIdx);
  });

  it("generates docker-compose.yml on port 8000", () => {
    const { files: out } = generateContainerFiles(files);
    const dc = out.find((f) => f.path === "docker-compose.yml")!;
    expect(dc).toBeDefined();
    expect(dc.content).toContain("8000:8000");
  });

  it("DEPLOY.md mentions localhost:8000", () => {
    const { files: out } = generateContainerFiles(files);
    const md = out.find((f) => f.path === "DEPLOY.md")!;
    expect(md).toBeDefined();
    expect(md.content).toContain("localhost:8000");
  });
});

describe("generateContainerFiles — Flask WITH requirements.txt", () => {
  const files: FileEntry[] = [
    { path: "app.py", content: "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef index(): return 'hi'" },
    { path: "requirements.txt", content: "flask\ngunicorn\n" },
  ];

  it("marks the project as container-ready", () => {
    const { isContainerReady } = generateContainerFiles(files);
    expect(isContainerReady).toBe(true);
  });

  it("Dockerfile installs from requirements.txt conditionally", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).toContain("if [ -f requirements.txt ]");
    expect(df.content).toContain("pip install --no-cache-dir -r requirements.txt");
  });
});

describe("generateContainerFiles — FastAPI without requirements.txt", () => {
  const files: FileEntry[] = [
    { path: "main.py", content: "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/')\ndef root(): return {}" },
  ];

  it("marks the project as container-ready", () => {
    const { isContainerReady } = generateContainerFiles(files);
    expect(isContainerReady).toBe(true);
  });

  it("generates a Dockerfile that uses uvicorn", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).toContain("uvicorn");
    expect(df.content).toContain("--host");
    expect(df.content).toContain("0.0.0.0");
  });

  it("Dockerfile does not use COPY requirements.txt*", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).not.toContain("COPY requirements.txt*");
  });

  it("CMD references the correct module and app variable", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).toContain("main:app");
  });
});

describe("generateContainerFiles — TypeScript Express server", () => {
  const files: FileEntry[] = [
    { path: "server.ts", content: "import express from 'express';\nconst app = express();\napp.listen(3000);" },
  ];

  it("marks the project as container-ready", () => {
    const { isContainerReady } = generateContainerFiles(files);
    expect(isContainerReady).toBe(true);
  });

  it("Dockerfile uses ts-node for TypeScript entry without a start script", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).toContain("ts-node");
    expect(df.content).toContain("server.ts");
  });

  it("DEPLOY.md mentions localhost:3000", () => {
    const { files: out } = generateContainerFiles(files);
    const md = out.find((f) => f.path === "DEPLOY.md")!;
    expect(md.content).toContain("localhost:3000");
  });
});

describe("generateContainerFiles — Node.js with npm start script", () => {
  const files: FileEntry[] = [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "my-app",
        scripts: { start: "node dist/index.js", build: "tsc" },
      }),
    },
    { path: "index.ts", content: "import express from 'express';\nconst app = express();\napp.listen(3000);" },
  ];

  it("marks the project as container-ready", () => {
    const { isContainerReady } = generateContainerFiles(files);
    expect(isContainerReady).toBe(true);
  });

  it("Dockerfile delegates to npm start", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).toContain('CMD ["npm", "start"]');
  });

  it("Dockerfile runs npm run build before start when build script exists", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).toContain("npm run build");
  });
});

describe("generateContainerFiles — Node.js plain JS without package.json", () => {
  const files: FileEntry[] = [
    { path: "index.js", content: "const http = require('http');\nconst s = http.createServer((req, res) => res.end('hi'));\ns.listen(3000);" },
  ];

  it("marks the project as container-ready", () => {
    const { isContainerReady } = generateContainerFiles(files);
    expect(isContainerReady).toBe(true);
  });

  it("Dockerfile uses node to run the entry point", () => {
    const { files: out } = generateContainerFiles(files);
    const df = out.find((f) => f.path === "Dockerfile")!;
    expect(df.content).toContain('CMD ["node"');
    expect(df.content).toContain("index.js");
  });
});

describe("generateContainerFiles — static HTML project", () => {
  const files: FileEntry[] = [
    { path: "index.html", content: "<html><body>hello</body></html>" },
  ];

  it("does not mark a static project as container-ready", () => {
    const { isContainerReady, type } = generateContainerFiles(files);
    expect(isContainerReady).toBe(false);
    expect(type).toBe("static");
  });

  it("does not inject a Dockerfile for static projects", () => {
    const { files: out } = generateContainerFiles(files);
    expect(out.find((f) => f.path === "Dockerfile")).toBeUndefined();
  });
});
