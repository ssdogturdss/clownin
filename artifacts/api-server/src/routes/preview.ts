import { Router, type IRouter } from "express";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

/**
 * GET /preview/:shortId
 *
 * Public (no auth). Serves an inlined HTML preview of the project identified
 * by the given short ID. CSS and JS files referenced in the HTML are inlined
 * so the page is self-contained. A "Built with Clownin 🤡" badge is injected
 * before </body> and social meta tags are added to <head>.
 */
router.get("/preview/:shortId", async (req, res): Promise<void> => {
  const { shortId } = req.params;

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.previewShortId, shortId))
    .limit(1);

  if (!project || !project.previewEnabled) {
    res.status(404).send(noPreviewPage("Preview not found"));
    return;
  }

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, project.id));

  // Find the root HTML file (index.html preferred, otherwise first .html file)
  const htmlFile =
    files.find((f) => f.path === "index.html" || f.path === "/index.html") ??
    files.find((f) => f.path.endsWith(".html"));

  if (!htmlFile) {
    res.status(200).send(noPreviewPage(
      `"${project.name}" has no HTML file`,
      project.name,
    ));
    return;
  }

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const fileMap = new Map(files.map((f) => [f.path, f.content]));
  const html = buildPreviewHtml(htmlFile.content, fileMap, project.name, baseUrl);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.send(html);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Takes raw HTML, inlines local CSS/JS references, appends the Clownin badge,
 * and injects social meta tags.
 */
function buildPreviewHtml(
  rawHtml: string,
  fileMap: Map<string, string>,
  projectName: string,
  baseUrl: string,
): string {
  let html = rawHtml;

  // Inline <link rel="stylesheet" href="...">
  html = html.replace(
    /<link\s[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi,
    (_match, href) => {
      const content = fileMap.get(href) ?? fileMap.get(href.replace(/^\.\//, ""));
      if (!content) return _match; // keep original if file not found
      return `<style>${escapeStyle(content)}</style>`;
    },
  );

  // Also handle <link href="..." rel="stylesheet">
  html = html.replace(
    /<link\s[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*\/?>/gi,
    (_match, href) => {
      const content = fileMap.get(href) ?? fileMap.get(href.replace(/^\.\//, ""));
      if (!content) return _match;
      return `<style>${escapeStyle(content)}</style>`;
    },
  );

  // Inline <script src="..."></script>
  html = html.replace(
    /<script\s[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi,
    (_match, src) => {
      const content = fileMap.get(src) ?? fileMap.get(src.replace(/^\.\//, ""));
      if (!content) return _match;
      return `<script>${content}</script>`;
    },
  );

  // Inject social meta tags into <head>
  const metaTags = buildMetaTags(projectName, baseUrl);
  if (/<head>/i.test(html)) {
    html = html.replace(/<head>/i, `<head>\n${metaTags}`);
  } else if (/<html/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>\n${metaTags}\n</head>`);
  }

  // Inject the badge + footer before </body> (or at the end)
  const badge = buildBadge();
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${badge}\n</body>`);
  } else {
    html += badge;
  }

  return html;
}

function buildMetaTags(projectName: string, baseUrl: string): string {
  const title = `${projectName} — Built with Clownin 🤡`;
  const description = "Built with Clownin — the AI coding app for your phone";
  const ogImage = `${baseUrl}/assets/og-image.jpg`;
  return `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeAttr(title)}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${escapeAttr(ogImage)}">
  <meta property="og:image:width" content="1024">
  <meta property="og:image:height" content="1024">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${escapeAttr(ogImage)}">`;
}

function buildBadge(): string {
  return `
<style>
  #clownin-badge {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 99999;
    background: rgba(0,0,0,0.82);
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    font-weight: 600;
    padding: 7px 12px;
    border-radius: 20px;
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 5px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.35);
    letter-spacing: 0.01em;
    transition: opacity 0.2s;
  }
  #clownin-badge:hover { opacity: 0.85; }
</style>
<a id="clownin-badge" href="https://clownin.app" target="_blank" rel="noopener">
  🤡 Built with Clownin
</a>`;
}

/** Returns a full standalone HTML page for the "no preview" state */
function noPreviewPage(headline: string, projectName?: string): string {
  const title = projectName ? `${projectName} — Clownin Preview` : "Clownin Preview";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeAttr(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #0d0d0d;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 24px;
      text-align: center;
    }
    .emoji { font-size: 56px; margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; color: #fff; }
    p { font-size: 15px; color: #888; margin-bottom: 28px; line-height: 1.5; }
    a.cta {
      display: inline-block;
      background: #fff;
      color: #000;
      font-weight: 700;
      font-size: 15px;
      padding: 12px 24px;
      border-radius: 24px;
      text-decoration: none;
    }
    a.cta:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="emoji">🤡</div>
  <h1>${escapeHtml(headline)}</h1>
  <p>This project doesn't have a shareable HTML preview yet.<br>
     Open it in Clownin to build and share your app.</p>
  <a class="cta" href="https://clownin.app">Build with Clownin</a>
</body>
</html>`;
}

function escapeStyle(css: string): string {
  return css.replace(/<\/style>/gi, "<\\/style>");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default router;
