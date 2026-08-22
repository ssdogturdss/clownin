/**
 * EAS Build proxy — uses the server-side EAS_CLOWNIN_KEY to forward
 * requests to Expo's GraphQL API on behalf of authenticated Clownin users.
 *
 * All routes require admin authorization (requireAdmin) in addition to
 * authentication (requireAuth). This prevents ordinary users from
 * enumerating or triggering builds on the shared EAS account.
 *
 * Real EAS GraphQL schema (probed 2026-08-22):
 *   - viewer { id username accounts { id name } }
 *   - account { byName(accountName: String!) { apps(limit: Int!, offset: Int!) { id name slug } } }
 *   - app { byId(appId: String!) { builds(limit: Int!, offset: Int!) { id status platform
 *       createdAt updatedAt expirationDate artifacts { buildUrl xcodeBuildLogsUrl } } } }
 *
 * Routes:
 *   GET  /eas/viewer          → account name + username for the configured key
 *   GET  /eas/builds          → recent builds across all apps on the account
 *   GET  /eas/apps            → apps on the account (with GitHub repo info)
 *   POST /eas/builds/trigger  → trigger an iOS or Android build for an app
 */

import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { requireAdmin } from "./admin";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const EAS_GQL = "https://api.expo.dev/graphql";

// ── Key helper ────────────────────────────────────────────────────────────────

function easKey(): string {
  const key = process.env["EAS_CLOWNIN_KEY"];
  if (!key) throw new Error("EAS_CLOWNIN_KEY is not configured");
  return key;
}

// ── Generic GQL request ───────────────────────────────────────────────────────

async function easQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(EAS_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${easKey()}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`EAS API ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data as T;
}

// ── Cached viewer (account list + apps) ──────────────────────────────────────

interface AppMeta { id: string; name: string; slug: string; accountName: string }
interface ViewerCache {
  username: string;
  accounts: { id: string; name: string }[];
  apps: AppMeta[];
}

let viewerCache: ViewerCache | null = null;
let viewerCacheTs = 0;
const VIEWER_CACHE_MS = 5 * 60 * 1000; // 5 min

async function getViewer(bust = false): Promise<ViewerCache> {
  if (!bust && viewerCache && Date.now() - viewerCacheTs < VIEWER_CACHE_MS) {
    return viewerCache;
  }

  // 1. Fetch viewer + accounts
  const viewerData = await easQuery<{
    viewer: { id: string; username: string; accounts: { id: string; name: string }[] };
  }>(`
    query ClowninViewer {
      viewer { id username accounts { id name } }
    }
  `);

  const accounts = viewerData.viewer?.accounts ?? [];
  const username = viewerData.viewer?.username ?? "";

  // 2. Fetch apps for each account in parallel
  const appsPerAccount = await Promise.all(
    accounts.map(async (acc) => {
      try {
        const data = await easQuery<{
          account: { byName: { apps: { id: string; name: string; slug: string }[] } };
        }>(
          `query ClowninApps($name: String!) {
            account { byName(accountName: $name) { apps(limit: 50, offset: 0) { id name slug } } }
          }`,
          { name: acc.name },
        );
        return (data.account?.byName?.apps ?? []).map((app) => ({
          ...app,
          accountName: acc.name,
        }));
      } catch {
        return [] as AppMeta[];
      }
    }),
  );

  viewerCache = { username, accounts, apps: appsPerAccount.flat() };
  viewerCacheTs = Date.now();
  return viewerCache;
}

// ── Build type ────────────────────────────────────────────────────────────────

interface RawBuild {
  id: string;
  status: string;
  platform: string;
  createdAt: string;
  updatedAt?: string;
  expirationDate?: string;
  artifacts?: { buildUrl?: string; xcodeBuildLogsUrl?: string };
  metrics?: { buildDuration?: number };
}

interface Build extends RawBuild {
  app: { name: string; slug: string };
  appId: string;
}

function easErrorResponse(res: import("express").Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : "Unknown EAS error";
  if (msg.includes("EAS_CLOWNIN_KEY is not configured")) {
    res.status(503).json({ error: "EAS is not configured on this server" });
  } else {
    res.status(502).json({ error: msg });
  }
}

// ── GET /api/eas/viewer ───────────────────────────────────────────────────────

router.get("/eas/viewer", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  try {
    const viewer = await getViewer(true);
    res.json({
      username: viewer.username,
      account: viewer.accounts[0]?.name ?? "",
      accounts: viewer.accounts,
      apps: viewer.apps,
    });
  } catch (err) {
    logger.error({ err }, "EAS viewer error");
    easErrorResponse(res, err);
  }
});

// ── GET /api/eas/builds ───────────────────────────────────────────────────────

const BUILDS_PER_APP = `
  query ClowninBuildsByApp($appId: String!) {
    app {
      byId(appId: $appId) {
        builds(limit: 20, offset: 0) {
          id status platform createdAt updatedAt expirationDate
          artifacts { buildUrl xcodeBuildLogsUrl }
        }
      }
    }
  }
`;

router.get("/eas/builds", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  try {
    const viewer = await getViewer();
    const { apps, username, accounts } = viewer;

    if (apps.length === 0) {
      res.json({ builds: [], account: accounts[0]?.name ?? "", username });
      return;
    }

    // Fetch builds for all apps in parallel
    const buildsByApp = await Promise.all(
      apps.map(async (app) => {
        try {
          const data = await easQuery<{
            app: { byId: { builds: RawBuild[] } };
          }>(BUILDS_PER_APP, { appId: app.id });

          return (data.app?.byId?.builds ?? []).map((b): Build => ({
            ...b,
            app: { name: app.name, slug: app.slug },
            appId: app.id,
          }));
        } catch (err) {
          logger.warn({ err, appId: app.id }, "Failed to fetch builds for app");
          return [] as Build[];
        }
      }),
    );

    // Merge and sort newest-first
    const builds = buildsByApp
      .flat()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({ builds, account: accounts[0]?.name ?? "", username });
  } catch (err) {
    logger.error({ err }, "EAS builds error");
    easErrorResponse(res, err);
  }
});

// ── GET /api/eas/builds/:buildId/logs ────────────────────────────────────────
// Returns build metadata + log lines for a single build.
// Uses the singular `build { byId }` root — consistent with the `app { byId }`
// pattern used elsewhere in this file (probed 2026-08-22).

// EAS Build schema (v22+) exposes `logFileUrls` — an array of presigned S3
// URLs whose content is plain text.  The deprecated `logFiles` field has the
// same shape but is omitted here.  `xcodeBuildLogsUrl` (inside artifacts) is
// an iOS-specific fallback used when logFileUrls is empty.
const BUILD_LOGS_QUERY = `
  query ClowninBuildLogs($buildId: ID!) {
    build {
      byId(buildId: $buildId) {
        id
        status
        platform
        createdAt
        updatedAt
        expirationDate
        metrics { buildDuration }
        logFileUrls
        artifacts {
          buildUrl
          xcodeBuildLogsUrl
        }
      }
    }
  }
`;

interface BuildDetail {
  id: string;
  status: string;
  platform: string;
  createdAt: string;
  updatedAt?: string;
  expirationDate?: string;
  metrics?: { buildDuration?: number };
  logFileUrls?: string[];
  artifacts?: { buildUrl?: string; xcodeBuildLogsUrl?: string };
}

router.get("/eas/builds/:buildId/logs", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { buildId } = req.params as { buildId: string };

  try {
    // 1. Try EAS GraphQL logs query (chunks returned by EAS directly)
    let build: BuildDetail | null = null;
    let logLines: string[] = [];
    let logsError: string | null = null;

    try {
      const data = await easQuery<{
        build: { byId: BuildDetail };
      }>(BUILD_LOGS_QUERY, { buildId });
      build = data?.build?.byId ?? null;
    } catch (gqlErr) {
      // Re-throw configuration errors so the outer handler returns 503
      if (
        gqlErr instanceof Error &&
        gqlErr.message.includes("EAS_CLOWNIN_KEY is not configured")
      ) {
        throw gqlErr;
      }
      logsError = gqlErr instanceof Error ? gqlErr.message : "GraphQL error";
      logger.warn({ err: gqlErr, buildId }, "EAS build logs GQL error");
    }

    if (!build) {
      // GraphQL failed entirely — return a minimal error payload
      res.status(502).json({ error: logsError ?? "Build not found", logs: [] });
      return;
    }

    // 2. Fetch text from each logFileUrl in parallel (EAS v22+ schema)
    const logUrls = build.logFileUrls ?? [];
    if (logUrls.length > 0) {
      const texts = await Promise.all(
        logUrls.map(async (url) => {
          try {
            // logFileUrls are presigned S3 URLs — no extra auth header needed
            const r = await fetch(url);
            return r.ok ? await r.text() : "";
          } catch {
            return "";
          }
        }),
      );
      logLines = texts.join("\n").split("\n");
    }

    // 3. iOS fallback: if logFileUrls is empty, try xcodeBuildLogsUrl from artifacts
    if (logLines.length === 0 && build.artifacts?.xcodeBuildLogsUrl) {
      try {
        const logsRes = await fetch(build.artifacts.xcodeBuildLogsUrl);
        if (logsRes.ok) {
          const text = await logsRes.text();
          logLines = text.split("\n");
        }
      } catch (fetchErr) {
        logger.warn({ err: fetchErr, buildId }, "EAS xcodeBuildLogsUrl fetch failed");
      }
    }

    res.json({
      id: build.id,
      status: build.status,
      platform: build.platform,
      createdAt: build.createdAt,
      updatedAt: build.updatedAt,
      expirationDate: build.expirationDate,
      durationSeconds: build.metrics?.buildDuration ?? null,
      buildUrl: build.artifacts?.buildUrl ?? null,
      logs: logLines,
    });
  } catch (err) {
    logger.error({ err, buildId }, "EAS build logs error");
    easErrorResponse(res, err);
  }
});

// ── GET /api/eas/apps ─────────────────────────────────────────────────────────
// Returns apps on the account with GitHub repo info so the client can show
// which projects are ready for remote builds.

const APPS_WITH_GITHUB_QUERY = `
  query ClowninAppsWithGitHub($accountName: String!, $limit: Int!) {
    account {
      byName(accountName: $accountName) {
        apps(limit: $limit, offset: 0) {
          id
          name
          slug
          githubRepository {
            githubRepositoryUrl
            metadata {
              githubRepoOwnerName
              githubRepoName
              defaultBranch
            }
          }
        }
      }
    }
  }
`;

router.get("/eas/apps", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query["limit"]) || 50, 100);
    const viewer = await getViewer();
    const accountName = viewer.accounts[0]?.name ?? "";

    if (!accountName) {
      res.json({ apps: [], account: "" });
      return;
    }

    const data = await easQuery<{
      account: { byName: { apps: unknown[] } };
    }>(APPS_WITH_GITHUB_QUERY, { accountName, limit });

    const apps = data.account?.byName?.apps ?? [];
    res.json({ apps, account: accountName });
  } catch (err) {
    logger.error({ err }, "EAS apps error");
    easErrorResponse(res, err);
  }
});

// ── POST /api/eas/builds/trigger ──────────────────────────────────────────────
// Triggers an iOS or Android build for the given app. The project archive is
// sourced from the app's linked GitHub repository (type: URL using codeload CDN).
// Body: { appId: string, platform: "IOS" | "ANDROID", buildProfile: string }

const CREATE_IOS_BUILD = `
  mutation ClowninCreateIosBuild($appId: String!, $job: IosJobInput!) {
    build {
      createIosBuild(appId: $appId, job: $job) {
        build {
          id
          status
          platform
          createdAt
          app { name slug }
          artifacts { buildUrl }
        }
      }
    }
  }
`;

const CREATE_ANDROID_BUILD = `
  mutation ClowninCreateAndroidBuild($appId: String!, $job: AndroidJobInput!) {
    build {
      createAndroidBuild(appId: $appId, job: $job) {
        build {
          id
          status
          platform
          createdAt
          app { name slug }
          artifacts { buildUrl }
        }
      }
    }
  }
`;

// We need to know the GitHub repo info for the app to construct the archive URL.
// Fetch it fresh at trigger time (not cached, since the user just picked the app).
const APP_GITHUB_QUERY = `
  query ClowninAppGitHub($appId: String!) {
    app {
      byId(appId: $appId) {
        githubRepository {
          githubRepositoryUrl
          metadata {
            githubRepoOwnerName
            githubRepoName
            defaultBranch
          }
        }
      }
    }
  }
`;

interface GitHubMeta {
  githubRepoOwnerName: string;
  githubRepoName: string;
  defaultBranch: string;
}

interface AppGitHubData {
  app: {
    byId: {
      githubRepository: {
        githubRepositoryUrl: string;
        metadata: GitHubMeta | null;
      } | null;
    };
  };
}

function friendlyTriggerError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("eas.json") || lower.includes("easjson"))
    return "No eas.json found. Run `eas build:configure` in your project first, then push to GitHub.";
  if (lower.includes("project id") || lower.includes("projectid"))
    return "Project not linked to EAS. Run `eas init` in your project and push to GitHub.";
  if (lower.includes("github") || lower.includes("not connected"))
    return "Connect this project to a GitHub repo on expo.dev → Project → GitHub, then try again.";
  if (lower.includes("credential") || lower.includes("certificate"))
    return "Build credentials not set up. Run `eas credentials` to configure signing.";
  return msg;
}

router.post("/eas/builds/trigger", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { appId, platform, buildProfile } = req.body as {
    appId?: string;
    platform?: string;
    buildProfile?: string;
  };

  if (!appId || typeof appId !== "string") {
    res.status(400).json({ error: "appId is required" });
    return;
  }
  if (platform !== "IOS" && platform !== "ANDROID") {
    res.status(400).json({ error: "platform must be IOS or ANDROID" });
    return;
  }
  if (!buildProfile || typeof buildProfile !== "string") {
    res.status(400).json({ error: "buildProfile is required" });
    return;
  }

  try {
    // Resolve GitHub archive URL for this app
    const ghData = await easQuery<AppGitHubData>(APP_GITHUB_QUERY, { appId });
    const gh = ghData?.app?.byId?.githubRepository;
    const meta = gh?.metadata;

    if (!gh || !meta) {
      res.status(422).json({
        error:
          "This project is not connected to a GitHub repository. " +
          "Link it on expo.dev → Project → GitHub to trigger remote builds.",
      });
      return;
    }

    const branch = meta.defaultBranch || "main";
    // GitHub codeload serves tar.gz archives; EAS uses this as the project source.
    const archiveUrl = `https://codeload.github.com/${meta.githubRepoOwnerName}/${meta.githubRepoName}/tar.gz/${branch}`;

    const job = {
      type: "MANAGED",
      projectRootDirectory: ".",
      projectArchive: { type: "URL", url: archiveUrl },
      buildProfile,
    };

    let build: unknown;
    if (platform === "IOS") {
      const data = await easQuery<{
        build: { createIosBuild: { build: unknown } };
      }>(CREATE_IOS_BUILD, { appId, job });
      build = data?.build?.createIosBuild?.build;
    } else {
      const data = await easQuery<{
        build: { createAndroidBuild: { build: unknown } };
      }>(CREATE_ANDROID_BUILD, { appId, job });
      build = data?.build?.createAndroidBuild?.build;
    }

    if (!build) throw new Error("No build returned from EAS API");
    res.json({ build });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to trigger build";
    logger.error({ err }, "EAS trigger error");
    const friendly = friendlyTriggerError(msg);
    if (msg.includes("EAS_CLOWNIN_KEY is not configured")) {
      res.status(503).json({ error: "EAS is not configured on this server" });
    } else {
      res.status(502).json({ error: friendly });
    }
  }
});

export default router;
