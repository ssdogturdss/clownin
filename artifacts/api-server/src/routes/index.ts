import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import projectsRouter from "./projects";
import filesRouter from "./files";
import executionRouter from "./execution";
import agentRouter from "./agent";
import githubRouter from "./github";
import deployRouter from "./deploy";
import privacyRouter from "./privacy";
import termsRouter from "./terms";
import serversRouter from "./servers";
import serveRouter from "./serve";
import envRouter from "./env";
import templatesRouter from "./templates";
import adminRouter from "./admin";
import promoRouter from "./promo";
import secretsRouter from "./secrets";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(templatesRouter);
router.use(projectsRouter);
router.use(filesRouter);
router.use(executionRouter);
router.use(agentRouter);
router.use(githubRouter);
router.use(deployRouter);
router.use(privacyRouter);
router.use(termsRouter);
router.use(serversRouter);
router.use(serveRouter);
router.use(envRouter);
router.use(adminRouter);
router.use(promoRouter);
router.use(secretsRouter);

export default router;

// Re-export preview router so app.ts can mount it outside /api
export { default as previewRouter } from "./preview";
