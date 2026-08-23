import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per agent run — stores file content before the run so users
 * can review what changed and restore an individual file or the full project.
 *
 * fileSnapshots is a JSON object keyed by file path:
 *   - string value → file existed; this was its content before the run
 *   - null value   → file did not exist before (it was created during the run)
 *
 * changedPaths / createdPaths / deletedPaths / renamedPaths track what the
 * agent actually did so the UI can display a concise summary without parsing
 * the full snapshot.
 */
export const agentRunSnapshotsTable = pgTable("agent_run_snapshots", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  projectId: integer("project_id").notNull(),
  sessionId: text("session_id"),
  /** JSON: { [path]: string | null } */
  fileSnapshots: text("file_snapshots").notNull().default("{}"),
  /** JSON: string[] — paths that were overwritten or surgically edited */
  changedPaths: text("changed_paths").notNull().default("[]"),
  /** JSON: string[] — paths the agent created from scratch */
  createdPaths: text("created_paths").notNull().default("[]"),
  /** JSON: string[] — paths the agent deleted */
  deletedPaths: text("deleted_paths").notNull().default("[]"),
  /** JSON: Array<{ from: string; to: string }> */
  renamedPaths: text("renamed_paths").notNull().default("[]"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Set in the finally block after the agent run ends. Used as the safety
   * baseline for restore: a file is considered "user-edited since the run"
   * only if its updatedAt is after this timestamp (not createdAt, which is
   * set before any mutations occur).
   */
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type AgentRunSnapshot = typeof agentRunSnapshotsTable.$inferSelect;
