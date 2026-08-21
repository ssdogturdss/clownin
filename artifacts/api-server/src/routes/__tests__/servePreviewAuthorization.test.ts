/**
 * Regression coverage for the owner-bound browser preview capability.
 *
 * Uses a real HTTP upstream and the production proxy router. Docker, SSH, and
 * the database are intentionally not involved: this test protects the security
 * boundary between a generated preview URL and a running preview service.
 */
import express from "express";
import { createServer, type Server } from "http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

process.env.JWT_SECRET ??= "preview-authorization-regression-test-secret";

const { serveProxyRouter, __serveTest } = await import("../serve");
const { signPreviewToken } = await import("../../lib/auth");

const projectId = 90_071;
const ownerId = 704;
let upstream: Server | undefined;

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startUpstream(): Promise<number> {
  upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end(`preview ready at ${req.url}`);
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Could not start preview test server");
  return address.port;
}

function registerLivePreview(port: number): void {
  __serveTest.setActiveServer({
    kind: "ssh",
    projectId,
    userId: ownerId,
    port,
    url: `https://preview.test/api/projects/${projectId}/serve/proxy/`,
    startedAt: new Date(Date.now() - 1_000),
    logBuffer: [],
    logListeners: new Set(),
    stopped: false,
    exitEmitted: false,
    srvConfig: { host: "127.0.0.1", port: 22, username: "preview-test" },
    remotePid: 9_001,
    killTunnel: null,
    killMonitor: null,
    killTail: null,
  });
}

function createProxyApp() {
  const app = express();
  app.use(serveProxyRouter);
  return app;
}

beforeEach(() => {
  __serveTest.clearActiveServers();
});

afterEach(async () => {
  __serveTest.clearActiveServers();
  await closeServer(upstream);
  upstream = undefined;
});

describe("live preview authorization", () => {
  it("exchanges an owner-bound bootstrap URL for a scoped cookie and proxies live content", async () => {
    registerLivePreview(await startUpstream());
    const app = createProxyApp();
    const previewToken = signPreviewToken(projectId, ownerId);

    await request(app)
      .get(`/api/projects/${projectId}/serve/proxy/`)
      .expect(401)
      .expect("Preview authorization required");

    const bootstrap = await request(app)
      .get(`/api/projects/${projectId}/serve/proxy/?preview_token=${encodeURIComponent(previewToken)}`)
      .expect(302);

    expect(bootstrap.headers.location).toBe(`/api/projects/${projectId}/serve/proxy/`);
    const rawSetCookie = bootstrap.headers["set-cookie"];
    const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
    expect(setCookie).toContain(`clownin_preview_${projectId}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");

    const cookie = setCookie.split(";")[0];
    const livePreview = await request(app)
      .get(bootstrap.headers.location)
      .set("Cookie", cookie)
      .expect(200);

    expect(livePreview.text).toBe("preview ready at /");
  });

  it("rejects a token issued for a different owner or project", async () => {
    registerLivePreview(await startUpstream());
    const app = createProxyApp();

    await request(app)
      .get(`/api/projects/${projectId}/serve/proxy/?preview_token=${signPreviewToken(projectId, ownerId + 1)}`)
      .expect(401)
      .expect("Preview authorization required");

    await request(app)
      .get(`/api/projects/${projectId}/serve/proxy/?preview_token=${signPreviewToken(projectId + 1, ownerId)}`)
      .expect(401)
      .expect("Preview authorization required");
  });

  it("returns the existing stopped-preview response after the live server is removed", async () => {
    registerLivePreview(await startUpstream());
    const app = createProxyApp();
    const previewToken = signPreviewToken(projectId, ownerId);

    __serveTest.removeActiveServer(projectId);

    await request(app)
      .get(`/api/projects/${projectId}/serve/proxy/?preview_token=${encodeURIComponent(previewToken)}`)
      .expect(503)
      .expect("No server running for this project");
  });
});