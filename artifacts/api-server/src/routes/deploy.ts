/**
 * Direct deployment to open-source hosting platforms.
 * No GitHub required — files are pushed straight from the DB.
 *
 * Supported:
 *  POST /projects/:id/deploy/netlify  → Netlify file-digest deploy
 *  POST /projects/:id/deploy/vercel   → Vercel file-upload deploy
 */
import { Router, type IRouter } from "express";
import { createHash } from "crypto";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { prepareNetlifyFiles, prepareVercelFiles } from "../lib/deployConfig";

const router: IRouter = Router();

// ── Netlify ───────────────────────────────────────────────────────────────────

async function netlifyFetch(
  token: string,
  path: string,
  method: string,
  body?: unknown,
  isOctet = false
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Clownin-App/1.0",
  };
  let bodyInit: Buffer | string | undefined;

  if (isOctet && body instanceof Buffer) {
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(body.length);
    bodyInit = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }

  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    method,
    headers,
    body: bodyInit,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { message?: string }).message || `Netlify error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

router.post(
  "/projects/:id/deploy/netlify",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (isNaN(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }

    const { token, siteName, siteId: existingSiteId } = req.body ?? {};
    if (!token) { res.status(400).json({ error: "token required" }); return; }

    const [project] = await db.select().from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId))).limit(1);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const files = await db.select().from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    if (!files.length) { res.status(400).json({ error: "No files to deploy" }); return; }

    try {
      const cleanName = (siteName || project.name)
        .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 63);

      // Prepare files: inject netlify.toml, serverless wrappers, code transforms
      const { files: deployFiles, type, warning } = prepareNetlifyFiles(
        files.map((f) => ({ path: f.path, content: f.content }))
      );
      req.log.info({ projectId, type, reusing: !!existingSiteId }, "Netlify deploy: detected project type");

      // 1. Create or reuse site
      let siteId: string;
      let liveUrl: string;
      if (existingSiteId) {
        // Re-deploy to the same site — preserves the URL users already shared
        siteId = existingSiteId;
        const siteInfo = await netlifyFetch(token, `/sites/${siteId}`, "GET") as { ssl_url?: string; url?: string };
        liveUrl = siteInfo.ssl_url || siteInfo.url || `https://${cleanName}.netlify.app`;
      } else {
        const site = await netlifyFetch(token, "/sites", "POST", { name: cleanName }) as { id: string; ssl_url?: string; url?: string };
        siteId = site.id;
        liveUrl = site.ssl_url || site.url || `https://${cleanName}.netlify.app`;
      }

      // 2. Build file digest map
      const fileMap: Record<string, string> = {};
      const contentMap: Record<string, Buffer> = {};
      for (const f of deployFiles) {
        const buf = Buffer.from(f.content, "utf8");
        const sha1 = createHash("sha1").update(buf).digest("hex");
        const key = f.path.startsWith("/") ? f.path : `/${f.path}`;
        fileMap[key] = sha1;
        contentMap[key] = buf;
      }

      // 3. Create deploy — Netlify tells us which files it actually needs
      const deploy = await netlifyFetch(token, `/sites/${siteId}/deploys`, "POST", {
        files: fileMap,
      }) as { id: string; required: string[]; ssl_url?: string };

      // 4. Upload required files
      const required = new Set(deploy.required ?? []);
      for (const [path, buf] of Object.entries(contentMap)) {
        const sha1 = fileMap[path];
        if (!required.has(sha1)) continue;
        const encodedPath = path.split("/").map(encodeURIComponent).join("/");
        await netlifyFetch(token, `/deploys/${deploy.id}/files${encodedPath}`, "PUT", buf, true);
      }

      req.log.info({ projectId, liveUrl, siteId }, "Deployed to Netlify");
      res.json({ url: liveUrl, platform: "netlify", deployId: deploy.id, siteId, type, warning });
    } catch (err: unknown) {
      req.log.error({ err }, "Netlify deploy failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "Deploy failed" });
    }
  }
);

// ── Vercel ────────────────────────────────────────────────────────────────────

async function vercelFetch(
  token: string,
  path: string,
  method: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Clownin-App/1.0",
    ...extraHeaders,
  };
  let bodyInit: Buffer | string | undefined;

  if (body instanceof Buffer) {
    headers["Content-Type"] = "application/octet-stream";
    bodyInit = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }

  const res = await fetch(`https://api.vercel.com${path}`, { method, headers, body: bodyInit });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) { // 409 = file already uploaded, that's fine
    const msg = (json as { error?: { message?: string } }).error?.message || `Vercel error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

router.post(
  "/projects/:id/deploy/vercel",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (isNaN(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }

    const { token, projectName } = req.body ?? {};
    if (!token) { res.status(400).json({ error: "token required" }); return; }

    const [project] = await db.select().from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId))).limit(1);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const files = await db.select().from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    if (!files.length) { res.status(400).json({ error: "No files to deploy" }); return; }

    try {
      const name = (projectName || project.name)
        .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 100);

      // Prepare files: inject vercel.json, transform app.listen → module.exports
      const { files: deployFiles, type, warning } = prepareVercelFiles(
        files.map((f) => ({ path: f.path, content: f.content }))
      );
      req.log.info({ projectId, type }, "Vercel deploy: detected project type");

      // 1. Upload each prepared file
      const fileRefs: Array<{ file: string; sha: string; size: number }> = [];

      for (const f of deployFiles) {
        const buf = Buffer.from(f.content, "utf8");
        const sha1 = createHash("sha1").update(buf).digest("hex");

        await vercelFetch(token, "/v2/files", "POST", buf, {
          "x-vercel-digest": sha1,
          "Content-Length": String(buf.length),
        });

        fileRefs.push({ file: f.path, sha: sha1, size: buf.length });
      }

      // 2. Create deployment
      const deployment = await vercelFetch(token, "/v13/deployments", "POST", {
        name,
        files: fileRefs,
        projectSettings: { framework: null },
        target: "production",
      }) as { url?: string; id?: string };

      if (!deployment.url) {
        throw new Error("Vercel did not return a deployment URL. Check your token and try again.");
      }
      const liveUrl = `https://${deployment.url}`;

      req.log.info({ projectId, liveUrl }, "Deployed to Vercel");
      res.json({ url: liveUrl, platform: "vercel", deploymentId: deployment.id, type, warning });
    } catch (err: unknown) {
      req.log.error({ err }, "Vercel deploy failed");
      res.status(500).json({ error: err instanceof Error ? err.message : "Deploy failed" });
    }
  }
);

export default router;
