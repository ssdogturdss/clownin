import { Router } from "express";
import { readFile } from "fs/promises";
import { join } from "path";

const privacyRouter = Router();

privacyRouter.get("/privacy", async (_req, res) => {
  try {
    const filePath = join(__dirname, "assets/privacy.html");
    const html = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch {
    res.status(500).send("Privacy policy unavailable.");
  }
});

export default privacyRouter;
