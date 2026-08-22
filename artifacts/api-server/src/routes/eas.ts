/**
 * EAS Build proxy — uses the server-side EAS_CLOWNIN_KEY to forward
 * requests to Expo's GraphQL API on behalf of authenticated Clownin users.
 *
 * Real EAS GraphQL schema (probed 2026-08-22):
 *   - viewer { id username accounts { id name } }
 *   - account { byName(accountName: String!) { apps(limit: Int!, offset: Int!) { id name slug } } }
 *   - app { byId(appId: String!) { builds(limit: Int!, offset: Int!) { id status platform
 *       createdAt updatedAt expirationDate artifacts { buildUrl xcodeBuildLogsUrl } } } }
 *
 * Routes:
 *   GET /eas/viewer  → account info for the configured key
 *   GET /eas/builds  → recent builds across all apps on all accounts
 */

import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
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
}

interface Build extends RawBuild {
  app: { name: string; slug: string };
}

// ── GET /api/eas/viewer ───────────────────────────────────────────────────────

router.get("/eas/viewer", requireAuth, async (_req, res) => {
  try {
    const viewer = await getViewer(true);
    res.json({
      username: viewer.username,
      account: viewer.accounts[0]?.name ?? "",
      accounts: viewer.accounts,
      apps: viewer.apps,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch Expo account";
    logger.error({ err }, "EAS viewer error");
    res.status(msg.includes("not configured") ? 503 : 502).json({ error: msg });
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

router.get("/eas/builds", requireAuth, async (_req, res) => {
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
    const msg = err instanceof Error ? err.message : "Failed to fetch builds";
    logger.error({ err }, "EAS builds error");
    res.status(msg.includes("not configured") ? 503 : 502).json({ error: msg });
  }
});

export default router;
