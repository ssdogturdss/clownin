/**
 * EAS Build proxy — uses the server-side EAS_CLOWNIN_KEY to forward
 * requests to Expo's GraphQL API on behalf of authenticated Clownin users.
 *
 * Routes:
 *   GET  /eas/viewer  → account name + username for the configured key
 *   GET  /eas/builds  → recent builds across all apps on the account
 */

import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const EAS_GQL = "https://api.expo.dev/graphql";

// ── Helpers ───────────────────────────────────────────────────────────────────

function easKey(): string {
  const key = process.env["EAS_CLOWNIN_KEY"];
  if (!key) throw new Error("EAS_CLOWNIN_KEY is not configured");
  return key;
}

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
    throw new Error(`EAS API responded with ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data as T;
}

// ── Cache account name so we don't re-query on every build fetch ──────────────

let cachedAccount: { name: string; username: string } | null = null;

async function getAccount(): Promise<{ name: string; username: string }> {
  if (cachedAccount) return cachedAccount;
  const data = await easQuery<{
    viewer: { id: string; username: string; accounts: { id: string; name: string }[] };
  }>(`
    query ClowninViewer {
      viewer {
        id
        username
        accounts { id name }
      }
    }
  `);
  const acc = data.viewer?.accounts?.[0];
  if (!acc) throw new Error("No Expo account found for this token");
  cachedAccount = { name: acc.name, username: data.viewer.username };
  return cachedAccount;
}

// ── GET /api/eas/viewer ───────────────────────────────────────────────────────

router.get("/eas/viewer", requireAuth, async (_req, res) => {
  try {
    // Bust the cache so callers always get fresh account info
    cachedAccount = null;
    const account = await getAccount();
    res.json({ account: account.name, username: account.username });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch Expo account";
    logger.error({ err }, "EAS viewer error");
    if (msg.includes("EAS_CLOWNIN_KEY is not configured")) {
      res.status(503).json({ error: "EAS is not configured on this server" });
    } else {
      res.status(502).json({ error: msg });
    }
  }
});

// ── GET /api/eas/builds ───────────────────────────────────────────────────────

const BUILDS_QUERY = `
  query ClowninBuilds($accountName: String!, $first: Int!) {
    account {
      byName(accountName: $accountName) {
        builds(first: $first) {
          edges {
            node {
              id
              status
              platform
              createdAt
              expirationDate
              app { name slug }
              artifacts { buildUrl }
            }
          }
        }
      }
    }
  }
`;

router.get("/eas/builds", requireAuth, async (req, res) => {
  try {
    const first = Math.min(Number(req.query["limit"]) || 40, 100);
    const { name: accountName, username } = await getAccount();

    const data = await easQuery<{
      account: { byName: { builds: { edges: { node: unknown }[] } } };
    }>(BUILDS_QUERY, { accountName, first });

    const builds = (data.account?.byName?.builds?.edges ?? []).map((e) => e.node);
    res.json({ builds, account: accountName, username });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch builds";
    logger.error({ err }, "EAS builds error");
    if (msg.includes("EAS_CLOWNIN_KEY is not configured")) {
      res.status(503).json({ error: "EAS is not configured on this server" });
    } else {
      res.status(502).json({ error: msg });
    }
  }
});

export default router;
