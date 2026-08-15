import { Router, type IRouter } from "express";
import { db, serversTable, projectsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { testSshConnection } from "../lib/sshExecution";

const router: IRouter = Router();

// ── List servers ──────────────────────────────────────────────────────────────
router.get("/servers", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const rows = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.userId, userId))
    .orderBy(serversTable.createdAt);

  // Never send credentials back in list responses
  res.json(rows.map(({ password: _p, privateKey: _k, ...s }) => s));
});

// ── Create server ─────────────────────────────────────────────────────────────
router.post("/servers", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const { name, host, port = 22, username, password, privateKey } = req.body ?? {};

  if (!name || !host || !username) {
    res.status(400).json({ error: "name, host, and username are required" });
    return;
  }
  if (!password && !privateKey) {
    res.status(400).json({ error: "Either password or privateKey is required" });
    return;
  }

  const [server] = await db
    .insert(serversTable)
    .values({
      userId,
      name,
      host,
      port: Number(port),
      username,
      password: password ?? null,
      privateKey: privateKey ?? null,
    })
    .returning();

  const { password: _p, privateKey: _k, ...safe } = server;
  res.status(201).json(safe);
});

// ── Get single server ─────────────────────────────────────────────────────────
router.get("/servers/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid server id" }); return; }

  const [server] = await db
    .select()
    .from(serversTable)
    .where(and(eq(serversTable.id, id), eq(serversTable.userId, userId)))
    .limit(1);

  if (!server) { res.status(404).json({ error: "Server not found" }); return; }

  const { password: _p, privateKey: _k, ...safe } = server;
  res.json(safe);
});

// ── Update server ─────────────────────────────────────────────────────────────
router.patch("/servers/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid server id" }); return; }

  const existing = await db
    .select()
    .from(serversTable)
    .where(and(eq(serversTable.id, id), eq(serversTable.userId, userId)))
    .limit(1);

  if (existing.length === 0) { res.status(404).json({ error: "Server not found" }); return; }

  const { name, host, port, username, password, privateKey } = req.body ?? {};
  const updates: Partial<typeof serversTable.$inferInsert> = {};
  if (name !== undefined) updates.name = name;
  if (host !== undefined) updates.host = host;
  if (port !== undefined) updates.port = Number(port);
  if (username !== undefined) updates.username = username;
  if (password !== undefined) updates.password = password;
  if (privateKey !== undefined) updates.privateKey = privateKey;

  const [updated] = await db
    .update(serversTable)
    .set(updates)
    .where(eq(serversTable.id, id))
    .returning();

  const { password: _p, privateKey: _k, ...safe } = updated;
  res.json(safe);
});

// ── Delete server ─────────────────────────────────────────────────────────────
router.delete("/servers/:id", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid server id" }); return; }

  const [existing] = await db
    .select()
    .from(serversTable)
    .where(and(eq(serversTable.id, id), eq(serversTable.userId, userId)))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Server not found" }); return; }

  // Detach from any projects first
  await db
    .update(projectsTable)
    .set({ serverId: null })
    .where(and(eq(projectsTable.serverId, id), eq(projectsTable.userId, userId)));

  await db.delete(serversTable).where(eq(serversTable.id, id));
  res.sendStatus(204);
});

// ── Test connection ───────────────────────────────────────────────────────────
router.post("/servers/:id/test", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getUser(req);
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid server id" }); return; }

  const [server] = await db
    .select()
    .from(serversTable)
    .where(and(eq(serversTable.id, id), eq(serversTable.userId, userId)))
    .limit(1);

  if (!server) { res.status(404).json({ error: "Server not found" }); return; }

  try {
    await testSshConnection({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      privateKey: server.privateKey,
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(200).json({ ok: false, error: msg });
  }
});

export default router;
