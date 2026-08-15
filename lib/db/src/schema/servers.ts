import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const serversTable = pgTable("servers", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  username: text("username").notNull(),
  /** Password auth — stored as plaintext for MVP */
  password: text("password"),
  /** Private key auth (PEM string) */
  privateKey: text("private_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertServerSchema = createInsertSchema(serversTable).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertServer = z.infer<typeof insertServerSchema>;
export type Server = typeof serversTable.$inferSelect;
