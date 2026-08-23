import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

// JWT_SECRET is only needed for preview-token signing/verification.
// requireAuth no longer validates tokens — authentication is disabled.
const JWT_SECRET = process.env.JWT_SECRET ?? "";

export interface AuthPayload {
  userId: number;
  email: string;
  username: string;
}

interface PreviewPayload {
  scope: "preview";
  projectId: number;
  userId: number;
}

// System user ID resolved at startup via ensureSystemUser() in seed.ts.
// Default 1 is a safe fallback before the DB resolves.
let systemUserId = 1;
export function setSystemUserId(id: number): void {
  systemUserId = id;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function signPreviewToken(projectId: number, userId: number): string {
  return jwt.sign({ scope: "preview", projectId, userId } satisfies PreviewPayload, JWT_SECRET, { expiresIn: "5m" });
}

export function verifyToken(token: string): AuthPayload {
  const payload = jwt.verify(token, JWT_SECRET) as Partial<AuthPayload> & { scope?: unknown };
  if (
    payload.scope !== undefined ||
    !Number.isInteger(payload.userId) ||
    typeof payload.email !== "string" ||
    typeof payload.username !== "string"
  ) {
    throw new Error("Invalid authentication token");
  }
  return payload as AuthPayload;
}

export function verifyPreviewToken(token: string): PreviewPayload {
  const payload = jwt.verify(token, JWT_SECRET) as Partial<PreviewPayload>;
  if (payload.scope !== "preview" || !Number.isInteger(payload.projectId) || !Number.isInteger(payload.userId)) {
    throw new Error("Invalid preview token");
  }
  return payload as PreviewPayload;
}

/**
 * Auth is disabled — every request runs as the system user.
 * Any Authorization header is accepted but its value is ignored.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { user: AuthPayload }).user = {
    userId: systemUserId,
    email: "ss@clownin.dev",
    username: "admin",
  };
  next();
}

export function getUser(req: Request): AuthPayload {
  return (req as Request & { user: AuthPayload }).user;
}
