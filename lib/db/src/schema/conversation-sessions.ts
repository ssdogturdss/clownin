import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per conversation session — tracks the human-readable name that
 * identifies the thread in the sessions list.
 */
export const conversationSessionsTable = pgTable("conversation_sessions", {
  sessionId: text("session_id").primaryKey(),
  projectId: integer("project_id").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ConversationSession = typeof conversationSessionsTable.$inferSelect;
