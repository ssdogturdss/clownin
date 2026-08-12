import { Router } from "express";
import { readFile } from "fs/promises";
import { join } from "path";

const termsRouter = Router();

termsRouter.get("/terms", async (_req, res) => {
  try {
    const filePath = join(__dirname, "assets/terms.html");
    const html = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch {
    res.status(500).send("Terms of service unavailable.");
  }
});

export default termsRouter;
