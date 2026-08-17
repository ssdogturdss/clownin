import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const conversationMessagesTable = pgTable("conversation_messages", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  sessionId: text("session_id"),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ConversationMessage = typeof conversationMessagesTable.$inferSelect;
