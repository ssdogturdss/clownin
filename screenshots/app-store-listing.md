# Clownin — App Store Listing Assets

## Short Description (~170 chars — paste into App Store Connect)

```
Build and deploy real apps from your phone. AI writes code, runs it, and fixes bugs instantly. Ship APIs, web apps & scrapers — no laptop needed.
```
*(146 chars)*

---

## Full Description (paste into App Store Connect — up to 4000 chars)

```
Clownin is the AI coding companion that lives in your pocket.

Describe what you want to build — a REST API, a Python scraper, a full-stack todo app — and Clownin's AI agent writes the code, runs it in a real terminal, and iterates until it works. No desktop required.

**What you can build**
• Express / Node.js REST APIs
• Python scripts and web scrapers  
• Full-stack apps with databases
• HTML landing pages and waitlists
• Any JavaScript or TypeScript project

**How it works**
1. Describe your idea (or pick a preset to get started in seconds)
2. Watch the AI write, save, and run your code live
3. Chat with the AI to add features, fix bugs, and iterate
4. Deploy directly to Netlify or Vercel — or push to GitHub with one tap

**Real developer tools on your phone**
• Syntax-highlighted code editor with autosave
• Streaming terminal output — see stdout and stderr in real time
• File manager — create, rename, and delete files in your project
• In-app HTML preview so you can see your web app before you ship
• Attach images or files to give the AI more context

**Deploy anywhere**
Connect your Netlify or Vercel account and go live in seconds. Or export to GitHub and deploy to Railway, Render, Fly.io, or any platform you prefer.

Clownin is for makers, students, developers, and anyone who has ever had an idea and wanted to build it — right now, from wherever they are.
```

---

## Keywords (≤ 100 chars, comma-separated — paste into App Store Connect)

```
coding,AI,code editor,developer,JavaScript,Python,deploy,GitHub,app builder,IDE
```
*(80 chars)*

---

## Age Rating

**4+** — No objectionable content. The app executes user-supplied code on remote servers; no adult content, no user-generated public sharing.

---

## Privacy Permissions Required (already in app.json infoPlist)

| Permission | Key | Usage string |
|---|---|---|
| Photo Library (read) | `NSPhotoLibraryUsageDescription` | "Clownin needs access to your photo library so you can attach images to your AI chat and share them with the coding assistant." |
| Photo Library (write) | `NSPhotoLibraryAddUsageDescription` | "Clownin needs permission to save images to your photo library." |

---

## Screenshots

| File | Size | Device class | Screen |
|---|---|---|---|
| `appstore-67inch.jpg` | 1290 × 2796 | 6.7" iPhone (iPhone 14 Pro Max / 15 Pro Max) | Onboarding / hero |
| `appstore-55inch.jpg` | 1242 × 2208 | 5.5" iPhone (iPhone 8 Plus) | Editor + AI chat |

---

## App Store Connect checklist

- [ ] Upload `appstore-67inch.jpg` under **6.7" Display** screenshots (required)
- [ ] Upload `appstore-55inch.jpg` under **5.5" Display** screenshots
- [ ] Paste short description into **Promotional Text** field
- [ ] Paste full description into **Description** field  
- [ ] Paste keywords into **Keywords** field (≤ 100 chars)
- [ ] Set Age Rating to **4+**
- [ ] Review privacy nutrition label — mark **Photos** as collected (linked to user)
