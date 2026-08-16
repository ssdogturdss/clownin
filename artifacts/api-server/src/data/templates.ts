/**
 * Server-side template registry. All 12 starter templates live here.
 * Updating this file and redeploying is enough — no mobile release required.
 */

export interface TemplateFile {
  path: string;
  content: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  language: string;
  /** MaterialCommunityIcons name shown in the mobile gallery */
  icon: string;
  /** Keywords used for client-side idea→template matching */
  keywords: string[];
  files: TemplateFile[];
}

export const TEMPLATES: Template[] = [
  // ── 1. Express API ──────────────────────────────────────────────────────────
  {
    id: "express-api",
    name: "Express API",
    description: "REST API with Express.js, JSON middleware, and a health endpoint",
    language: "javascript",
    icon: "lightning-bolt",
    keywords: ["express", "rest api", "api server", "http server", "node api", "nodejs api", "express.js", "expressjs", "node server", "backend api"],
    files: [
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name: "express-api",
            version: "1.0.0",
            main: "index.js",
            scripts: { start: "node index.js" },
            dependencies: { express: "^4.18.2" },
          },
          null,
          2
        ) + "\n",
      },
      {
        path: "index.js",
        content: `const express = require('express');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Hello from Express! 🤡' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/users', (req, res) => {
  res.json([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
  ]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(\`Server on http://localhost:\${PORT}\`));
`,
      },
    ],
  },

  // ── 2. Flask API ────────────────────────────────────────────────────────────
  {
    id: "flask-api",
    name: "Flask API",
    description: "Python REST API with Flask, JSON responses, and CORS",
    language: "python",
    icon: "language-python",
    keywords: ["flask", "python api", "python rest", "python server", "python backend", "flask api", "python web"],
    files: [
      {
        path: "requirements.txt",
        content: "flask\nflask-cors\n",
      },
      {
        path: "app.py",
        content: `import os
from flask import Flask, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

@app.route('/')
def index():
    return jsonify({'message': 'Hello from Flask! 🤡'})

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/users')
def users():
    return jsonify([
        {'id': 1, 'name': 'Alice'},
        {'id': 2, 'name': 'Bob'},
    ])

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
`,
      },
    ],
  },

  // ── 3. React (esbuild) ──────────────────────────────────────────────────────
  {
    id: "react-esbuild",
    name: "React App",
    description: "React SPA bundled with esbuild and served from Node.js",
    language: "javascript",
    icon: "react",
    keywords: ["react", "react app", "react website", "react frontend", "react ui", "spa", "single page app", "react component", "jsx", "tsx"],
    files: [
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name: "react-app",
            version: "1.0.0",
            main: "serve.js",
            scripts: { start: "node serve.js" },
            dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
            devDependencies: { esbuild: "^0.20.0" },
          },
          null,
          2
        ) + "\n",
      },
      {
        path: "serve.js",
        content: `const esbuild = require('esbuild');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 3000;
const SERVE_DIR = path.resolve(__dirname, 'public');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

// Build once, then serve
esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  outfile: 'public/bundle.js',
  jsx: 'automatic',
  logLevel: 'info',
}).then(() => {
  const server = http.createServer((req, res) => {
    // Strip query string, normalize, resolve against public/ only
    const urlPath = (req.url || '/').split('?')[0];
    const resolved = path.resolve(SERVE_DIR, urlPath === '/' ? 'index.html' : urlPath.replace(/^\\//, ''));

    // Security: reject any path that escapes the public directory
    if (resolved !== SERVE_DIR && !resolved.startsWith(SERVE_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(resolved, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'text/plain' });
      res.end(data);
    });
  });
  server.listen(PORT, () => console.log(\`React app on http://localhost:\${PORT}\`));
}).catch(() => process.exit(1));
`,
      },
      {
        path: "public/index.html",
        content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>React App</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0a0a0a; color: #f0f0f0; }
    button { background: #ff6b35; color: #fff; border: none; padding: .5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 1rem; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="bundle.js"></script>
</body>
</html>
`,
      },
      {
        path: "src/main.jsx",
        content: `import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')).render(<App />);
`,
      },
      {
        path: "src/App.jsx",
        content: `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1>React App 🤡</h1>
      <p>Count: {count}</p>
      <button onClick={() => setCount(c => c + 1)}>Click me</button>
    </div>
  );
}
`,
      },
    ],
  },

  // ── 4. Python CLI ───────────────────────────────────────────────────────────
  {
    id: "python-cli",
    name: "Python CLI",
    description: "Command-line tool with argparse, flags, and colored output",
    language: "python",
    icon: "console-line",
    keywords: ["python cli", "command line", "cli tool", "python script", "argparse", "python tool", "command line tool", "terminal tool"],
    files: [
      {
        path: "main.py",
        content: `import argparse
import sys

def greet(name: str, shout: bool = False) -> str:
    msg = f'Hello, {name}! 🤡'
    return msg.upper() if shout else msg

def main():
    parser = argparse.ArgumentParser(description='A friendly CLI tool')
    parser.add_argument('name', nargs='?', default='World', help='Name to greet')
    parser.add_argument('--shout', action='store_true', help='Shout the greeting')
    parser.add_argument('--count', type=int, default=1, help='How many times to greet')
    args = parser.parse_args()

    for _ in range(args.count):
        print(greet(args.name, args.shout))

if __name__ == '__main__':
    main()
`,
      },
    ],
  },

  // ── 5. Bash Script ──────────────────────────────────────────────────────────
  {
    id: "bash-script",
    name: "Bash Script",
    description: "Shell script with argument parsing, colors, and error handling",
    language: "bash",
    icon: "bash",
    keywords: ["bash", "shell script", "bash script", "shell", "sh script", "bash tool", "shell automation", "bash automation"],
    files: [
      {
        path: "main.sh",
        content: `#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
NC='\\033[0m'

NAME=\${1:-"World"}
echo -e "\${GREEN}Hello, \${NAME}! 🤡\${NC}"

echo ""
echo -e "\${YELLOW}System info:\${NC}"
echo "  OS: \$(uname -s)"
echo "  Shell: \$SHELL"
echo "  Date: \$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo -e "\${YELLOW}Working directory:\${NC}"
ls -la | head -10
`,
      },
    ],
  },

  // ── 6. Go HTTP Server ───────────────────────────────────────────────────────
  {
    id: "go-http",
    name: "Go HTTP Server",
    description: "HTTP server with routing, JSON responses, and middleware",
    language: "go",
    icon: "language-go",
    keywords: ["go", "golang", "go server", "go http", "golang server", "go api", "golang api", "gin", "goroutine"],
    files: [
      {
        path: "main.go",
        content: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

type Response struct {
	Message   string    \`json:"message"\`
	Timestamp time.Time \`json:"timestamp"\`
}

func jsonHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{
		Message:   "Hello from Go! 🤡",
		Timestamp: time.Now(),
	})
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintln(w, \`{"status":"ok"}\`)
}

func logger(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next(w, r)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", logger(jsonHandler))
	mux.HandleFunc("/health", logger(healthHandler))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Server running on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
`,
      },
    ],
  },

  // ── 7. Discord Bot ──────────────────────────────────────────────────────────
  {
    id: "discord-bot",
    name: "Discord Bot",
    description: "Discord bot with slash commands and message handling via discord.js",
    language: "javascript",
    icon: "discord",
    keywords: ["discord", "discord bot", "discord.js", "discordjs", "discord server", "discord slash", "discord commands"],
    files: [
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name: "discord-bot",
            version: "1.0.0",
            main: "index.js",
            dependencies: { "discord.js": "^14.14.1" },
          },
          null,
          2
        ) + "\n",
      },
      {
        path: "index.js",
        content: `const { Client, GatewayIntentBits, Events } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(\`✅ Ready! Logged in as \${c.user.tag}\`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content === '!ping') {
    await message.reply('Pong! 🤡');
  }

  if (message.content === '!hello') {
    await message.reply(\`Hello, \${message.author.username}! 👋\`);
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ Set the DISCORD_TOKEN environment variable');
  process.exit(1);
}

client.login(token);
`,
      },
    ],
  },

  // ── 8. Telegram Bot ─────────────────────────────────────────────────────────
  {
    id: "telegram-bot",
    name: "Telegram Bot",
    description: "Telegram bot with command handlers using python-telegram-bot",
    language: "python",
    icon: "send",
    keywords: ["telegram", "telegram bot", "telegrambot", "python telegram", "telegram chatbot", "telegram commands"],
    files: [
      {
        path: "requirements.txt",
        content: "python-telegram-bot\n",
      },
      {
        path: "bot.py",
        content: `import os
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

logging.basicConfig(level=logging.INFO)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text('Hello! I am your bot 🤡\\n\\nCommands:\\n/start - This message\\n/help - Show help')

async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text('Send me any message and I will echo it back!')

async def echo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(f'You said: {update.message.text}')

def main():
    token = os.environ.get('TELEGRAM_TOKEN')
    if not token:
        print('❌ Set the TELEGRAM_TOKEN environment variable')
        return

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler('start', start))
    app.add_handler(CommandHandler('help', help_cmd))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, echo))

    print('Bot running...')
    app.run_polling()

if __name__ == '__main__':
    main()
`,
      },
    ],
  },

  // ── 9. SQLite CRUD ──────────────────────────────────────────────────────────
  {
    id: "sqlite-crud",
    name: "SQLite CRUD",
    description: "Create, read, update, and delete records with Python's built-in SQLite",
    language: "python",
    icon: "database",
    keywords: ["sqlite", "sqlite crud", "database", "python database", "sql", "crud", "python sql", "sqlite database", "db crud"],
    files: [
      {
        path: "main.py",
        content: `import sqlite3
from datetime import datetime

DB_FILE = 'data.db'

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def setup(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS items (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            name  TEXT NOT NULL,
            done  INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
    ''')
    conn.commit()

def create(conn, name: str) -> int:
    cur = conn.execute(
        'INSERT INTO items (name, created_at) VALUES (?, ?)',
        (name, datetime.now().isoformat())
    )
    conn.commit()
    return cur.lastrowid

def read_all(conn):
    return conn.execute('SELECT * FROM items ORDER BY id').fetchall()

def update(conn, item_id: int, done: bool):
    conn.execute('UPDATE items SET done = ? WHERE id = ?', (int(done), item_id))
    conn.commit()

def delete(conn, item_id: int):
    conn.execute('DELETE FROM items WHERE id = ?', (item_id,))
    conn.commit()

def print_items(rows):
    if not rows:
        print('  (empty)')
        return
    for row in rows:
        status = '✅' if row['done'] else '⬜'
        print(f'  [{row["id"]}] {status} {row["name"]}')

def main():
    conn = get_db()
    setup(conn)

    print('Creating items...')
    create(conn, 'Buy groceries 🛒')
    create(conn, 'Write code 💻')
    create(conn, 'Clown around 🤡')

    print('\\nAll items:')
    print_items(read_all(conn))

    print('\\nMarking item #1 as done...')
    update(conn, 1, True)

    print('\\nAfter update:')
    print_items(read_all(conn))

    print('\\nDeleting item #2...')
    delete(conn, 2)

    print('\\nFinal state:')
    print_items(read_all(conn))

    conn.close()

if __name__ == '__main__':
    main()
`,
      },
    ],
  },

  // ── 10. WebSocket Chat ──────────────────────────────────────────────────────
  {
    id: "websocket-chat",
    name: "WebSocket Chat",
    description: "Real-time chat server that broadcasts messages to all connected clients",
    language: "javascript",
    icon: "chat-processing-outline",
    keywords: ["websocket", "websocket chat", "chat server", "real-time chat", "live chat", "ws server", "realtime", "real time", "socket"],
    files: [
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name: "websocket-chat",
            version: "1.0.0",
            main: "server.js",
            scripts: { start: "node server.js" },
            dependencies: { ws: "^8.16.0" },
          },
          null,
          2
        ) + "\n",
      },
      {
        path: "server.js",
        content: `const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket chat server 🤡\\nConnect with: ws://localhost:8080\\n');
});

const wss = new WebSocketServer({ server });
const clients = new Map(); // ws → username
let nextId = 1;

wss.on('connection', (ws) => {
  const username = \`user\${nextId++}\`;
  clients.set(ws, username);
  console.log(\`\${username} connected (\${clients.size} online)\`);

  broadcast(\`[server] \${username} joined the chat\`);

  ws.on('message', (data) => {
    const text = data.toString().trim();
    if (!text) return;
    const msg = \`[\${username}] \${text}\`;
    console.log(msg);
    broadcast(msg);
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(\`\${username} disconnected (\${clients.size} online)\`);
    broadcast(\`[server] \${username} left the chat\`);
  });
});

function broadcast(msg) {
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(\`WebSocket server on ws://localhost:\${PORT}\`));
`,
      },
    ],
  },

  // ── 11. Cron Job ────────────────────────────────────────────────────────────
  {
    id: "cron-job",
    name: "Cron Job",
    description: "Scheduled task runner with node-cron — runs jobs on a timed schedule",
    language: "javascript",
    icon: "clock-outline",
    keywords: ["cron", "cron job", "scheduled task", "scheduler", "node-cron", "job scheduler", "timed task", "periodic task", "schedule"],
    files: [
      {
        path: "package.json",
        content: JSON.stringify(
          {
            name: "cron-job",
            version: "1.0.0",
            main: "index.js",
            scripts: { start: "node index.js" },
            dependencies: { "node-cron": "^3.0.3" },
          },
          null,
          2
        ) + "\n",
      },
      {
        path: "index.js",
        content: `const cron = require('node-cron');

function timestamp() {
  return new Date().toISOString();
}

// Every minute
cron.schedule('* * * * *', () => {
  console.log(\`[\${timestamp()}] ⏰ Minute job ran\`);
});

// Every 10 seconds (for quick testing)
cron.schedule('*/10 * * * * *', () => {
  console.log(\`[\${timestamp()}] 🤡 10-second job ran\`);
});

// Every day at midnight (UTC)
cron.schedule('0 0 * * *', () => {
  console.log(\`[\${timestamp()}] 🌙 Daily job ran\`);
});

console.log('Cron scheduler started — jobs running:');
console.log('  */10 * * * * *  every 10 seconds');
console.log('  * * * * *        every minute');
console.log('  0 0 * * *        daily at midnight UTC');
`,
      },
    ],
  },

  // ── 12. Static HTML Page ────────────────────────────────────────────────────
  {
    id: "static-html",
    name: "Static HTML Page",
    description: "Responsive HTML/CSS/JS page — edit and preview in the browser",
    language: "javascript",
    icon: "language-html5",
    keywords: ["html", "static html", "html page", "html website", "static website", "static page", "landing page", "html css", "html js", "web page", "webpage"],
    files: [
      {
        path: "index.html",
        content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Page</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #f0f0f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.5rem;
      padding: 2rem;
    }
    h1 { font-size: 2.5rem; color: #ff6b35; }
    p { color: #aaa; max-width: 480px; text-align: center; line-height: 1.6; }
    .counter {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    button {
      background: #ff6b35;
      color: #fff;
      border: none;
      padding: 0.6rem 1.4rem;
      border-radius: 8px;
      cursor: pointer;
      font-size: 1.1rem;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    #count { font-size: 2rem; font-weight: 700; min-width: 3ch; text-align: center; }
  </style>
</head>
<body>
  <h1>Hello, World! 🤡</h1>
  <p>Edit this file to build your page. HTML, CSS, and JavaScript all in one place.</p>
  <div class="counter">
    <button id="dec">−</button>
    <span id="count">0</span>
    <button id="inc">+</button>
  </div>
  <script>
    let count = 0;
    const el = document.getElementById('count');
    document.getElementById('inc').addEventListener('click', () => { count++; el.textContent = count; });
    document.getElementById('dec').addEventListener('click', () => { count--; el.textContent = count; });
  </script>
</body>
</html>
`,
      },
      {
        path: "serve.js",
        content: `// Serve index.html over HTTP so you can preview it in the browser.
// Run: node serve.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SERVE_DIR = path.resolve(__dirname);

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

const server = http.createServer((req, res) => {
  // Strip query string, normalize, resolve against serve root
  const urlPath = (req.url || '/').split('?')[0];
  const resolved = path.resolve(SERVE_DIR, urlPath === '/' ? 'index.html' : urlPath.replace(/^\\//, ''));

  // Security: reject any path that escapes the serve directory
  if (resolved !== SERVE_DIR && !resolved.startsWith(SERVE_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(\`Page served at http://localhost:\${PORT}\`));
`,
      },
    ],
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
