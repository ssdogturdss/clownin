import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

if (!process.env.JWT_SECRET) {
  throw new Error(
    "JWT_SECRET environment variable is required but was not set. " +
    "Set it to a long random string before starting the server.",
  );
}

// Safe after the guard above — process exits if JWT_SECRET is missing
const JWT_SECRET = process.env.JWT_SECRET as string;

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

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = verifyToken(token);
    (req as Request & { user: AuthPayload }).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function getUser(req: Request): AuthPayload {
  return (req as Request & { user: AuthPayload }).user;
}
