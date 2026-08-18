import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router, { previewRouter } from "./routes";
import privacyRouter from "./routes/privacy";
import termsRouter from "./routes/terms";
import webhookRouter from "./routes/webhooks";
import { logger } from "./lib/logger";
import { serveProxyRouter } from "./routes/serve";
import { startSubscriptionSyncJob } from "./lib/subscriptionSync";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// ⚠️  The serve proxy MUST be mounted before express.json() / express.urlencoded().
// Body parsers consume req as a stream; the proxy needs to pipe it raw to the
// upstream port. Mounting here ensures no body parser runs first for proxy paths.
app.use(serveProxyRouter);

// ⚠️  RevenueCat webhook MUST be mounted before express.json() because it
// uses express.raw() internally to capture the raw body for auth verification.
app.use(webhookRouter);

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// Serve static assets (og:image etc.) at /preview/...
app.use("/preview", express.static(path.join(__dirname, "assets")));

// Serve admin panel static files when present.
// In Docker / self-hosted deployments the admin-panel/ directory is copied
// next to the API server dist so both services are served from a single
// container.  When running under Replit the directory won't exist and this
// block is a no-op — the admin panel runs as its own Vite dev process.
const adminPanelDist = path.join(__dirname, "../../admin-panel");
if (fs.existsSync(adminPanelDist)) {
  app.use("/admin-panel", express.static(adminPanelDist));
  // SPA fallback: serve index.html for any unknown /admin-panel/* route
  app.get("/admin-panel/*path", (_req, res) => {
    res.sendFile(path.join(adminPanelDist, "index.html"));
  });
}

// Public preview pages — mounted outside /api so the URL is /preview/:shortId
app.use(previewRouter);

// Privacy policy & Terms of Service — stable public URLs for App Store Connect
app.use(privacyRouter);
app.use(termsRouter);

app.use("/api", router);

// Start the daily subscription sync job to heal stale Pro states from
// missed or failed RevenueCat webhook deliveries.
startSubscriptionSyncJob();

export default app;
