import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import projectsRouter from "./projects";
import filesRouter from "./files";
import executionRouter from "./execution";
import agentRouter from "./agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(projectsRouter);
router.use(filesRouter);
router.use(executionRouter);
router.use(agentRouter);

export default router;
