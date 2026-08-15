import { Router, type IRouter } from "express";
import { TEMPLATES } from "../data/templates";

const router: IRouter = Router();

/**
 * GET /templates
 * Public — no auth required. Returns template metadata (no file contents)
 * so the mobile gallery can load quickly. File contents are fetched server-side
 * when the user creates a project from a template (POST /projects?templateId=…).
 */
router.get("/templates", (_req, res): void => {
  const list = TEMPLATES.map(({ id, name, description, language, icon }) => ({
    id,
    name,
    description,
    language,
    icon,
  }));
  res.json(list);
});

export default router;
