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

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
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

export default router;

// Re-export preview router so app.ts can mount it outside /api
export { default as previewRouter } from "./preview";
