import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router, { previewRouter } from "./routes";
import privacyRouter from "./routes/privacy";
import termsRouter from "./routes/terms";
import { logger } from "./lib/logger";

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
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Serve static assets (og:image etc.) at /preview/...
app.use("/preview", express.static(path.join(__dirname, "assets")));

// Public preview pages — mounted outside /api so the URL is /preview/:shortId
app.use(previewRouter);

// Privacy policy & Terms of Service — stable public URLs for App Store Connect
app.use(privacyRouter);
app.use(termsRouter);

app.use("/api", router);

export default app;
