import { Router, type IRouter } from "express";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { generateContainerFiles } from "../lib/deployConfig";

const router: IRouter = Router();

async function ghFetch(token: string, path: string, method: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "Clownin-App/1.0",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      (json as { message?: string }).message ||
      `GitHub API error ${res.status}`;
    throw new Error(msg);
  }

  return json;
}

// POST /projects/:id/github/push
// Body: { token, repoName, isPrivate, description?, existingRepo?: { owner, repoName } }
router.post(
  "/projects/:id/github/push",
  requireAuth,
  async (req, res): Promise<void> => {
    const { userId } = getUser(req);
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const projectId = parseInt(rawId, 10);

    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const { token, repoName, isPrivate = true, description = "", existingRepo } = req.body ?? {};
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "GitHub token is required" });
      return;
    }

    // For new repos, repoName is required. For updates it comes from existingRepo.
    const isUpdate = existingRepo &&
      typeof existingRepo.owner === "string" &&
      typeof existingRepo.repoName === "string";

    if (!isUpdate && (!repoName || typeof repoName !== "string")) {
      res.status(400).json({ error: "repoName is required" });
      return;
    }

    // Verify ownership
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
      .limit(1);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const dbFiles = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    if (dbFiles.length === 0) {
      res.status(400).json({ error: "Project has no files to push" });
      return;
    }

    // Inject Dockerfile + docker-compose.yml + DEPLOY.md for server projects
    const { files, type, isContainerReady } = generateContainerFiles(
      dbFiles.map((f) => ({ path: f.path, content: f.content }))
    );

    try {
      if (isUpdate) {
        // ── Update path: push a new commit on top of existing repo ──
        const owner = existingRepo.owner as string;
        const repo = existingRepo.repoName as string;

        // 1. Get latest commit SHA on main
        const refData = (await ghFetch(
          token,
          `/repos/${owner}/${repo}/git/ref/heads/main`,
          "GET"
        )) as { object: { sha: string } };
        const parentSha = refData.object.sha;

        // 2. Create blobs for each file (batched)
        const BATCH = 5;
        const blobs: Array<{ sha: string }> = [];
        for (let i = 0; i < files.length; i += BATCH) {
          const batch = files.slice(i, i + BATCH);
          const batchBlobs = await Promise.all(
            batch.map((f) =>
              ghFetch(token, `/repos/${owner}/${repo}/git/blobs`, "POST", {
                content: Buffer.from(f.content, "utf8").toString("base64"),
                encoding: "base64",
              }) as Promise<{ sha: string }>
            )
          );
          blobs.push(...batchBlobs);
        }

        // 3. Create tree (no base_tree so the commit replaces all tracked files)
        const tree = (await ghFetch(
          token,
          `/repos/${owner}/${repo}/git/trees`,
          "POST",
          {
            tree: files.map((f, i) => ({
              path: f.path,
              mode: "100644",
              type: "blob",
              sha: blobs[i].sha,
            })),
          }
        )) as { sha: string };

        // 4. Create commit with parent
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
        const commitMsg = `Update from Clownin 🤡\n\nProject: ${project.name}\nPushed at: ${timestamp}`;

        const commit = (await ghFetch(
          token,
          `/repos/${owner}/${repo}/git/commits`,
          "POST",
          {
            message: commitMsg,
            tree: tree.sha,
            parents: [parentSha],
          }
        )) as { sha: string };

        // 5. Fast-forward main ref
        await ghFetch(token, `/repos/${owner}/${repo}/git/refs/heads/main`, "PATCH", {
          sha: commit.sha,
          force: false,
        });

        const repoUrl = `https://github.com/${owner}/${repo}`;
        req.log.info({ projectId, repoUrl, isContainerReady, type }, "Updated GitHub repo");
        res.json({ repoUrl, owner, repoName: repo, isContainerReady, projectType: type });
      } else {
        // ── Create path: new repo + initial commit ──

        // 1. Get authenticated user
        const user = (await ghFetch(token, "/user", "GET")) as { login: string };
        const owner = user.login;

        // 2. Create repo
        await ghFetch(token, "/user/repos", "POST", {
          name: repoName,
          description: description || `Built with Clownin 🤡`,
          private: isPrivate,
          auto_init: false,
        });

        // 3. Create blobs for each file (batched)
        const BATCH = 5;
        const blobs: Array<{ sha: string }> = [];
        for (let i = 0; i < files.length; i += BATCH) {
          const batch = files.slice(i, i + BATCH);
          const batchBlobs = await Promise.all(
            batch.map((f) =>
              ghFetch(token, `/repos/${owner}/${repoName}/git/blobs`, "POST", {
                content: Buffer.from(f.content, "utf8").toString("base64"),
                encoding: "base64",
              }) as Promise<{ sha: string }>
            )
          );
          blobs.push(...batchBlobs);
        }

        // 4. Create tree
        const tree = (await ghFetch(
          token,
          `/repos/${owner}/${repoName}/git/trees`,
          "POST",
          {
            tree: files.map((f, i) => ({
              path: f.path,
              mode: "100644",
              type: "blob",
              sha: blobs[i].sha,
            })),
          }
        )) as { sha: string };

        // 5. Create initial commit (no parents — empty repo)
        const commitMsg = isContainerReady
          ? `Initial commit from Clownin 🤡\n\nProject: ${project.name}\n\nIncludes Dockerfile + docker-compose.yml — ready for Railway, Render, or Fly.io.`
          : `Initial commit from Clownin 🤡\n\nProject: ${project.name}`;

        const commit = (await ghFetch(
          token,
          `/repos/${owner}/${repoName}/git/commits`,
          "POST",
          {
            message: commitMsg,
            tree: tree.sha,
            parents: [],
          }
        )) as { sha: string };

        // 6. Create main branch ref
        await ghFetch(token, `/repos/${owner}/${repoName}/git/refs`, "POST", {
          ref: "refs/heads/main",
          sha: commit.sha,
        });

        // 7. Set default branch to main
        await ghFetch(token, `/repos/${owner}/${repoName}`, "PATCH", {
          default_branch: "main",
        });

        const repoUrl = `https://github.com/${owner}/${repoName}`;
        req.log.info({ projectId, repoUrl, isContainerReady, type }, "Pushed to GitHub");
        res.json({ repoUrl, owner, repoName, isContainerReady, projectType: type });
      }
    } catch (err: unknown) {
      req.log.error({ err }, "GitHub push failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : "GitHub push failed",
      });
    }
  }
);

export default router;
