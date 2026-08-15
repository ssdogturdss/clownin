import { pgTable, text, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Per-project environment variables.
 * Values are stored AES-256-GCM encrypted; raw values are never returned to
 * clients — only the key name and a masked preview are exposed.
 */
export const projectEnvVarsTable = pgTable(
  "project_env_vars",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull(),
    /** Environment variable name — must be a valid shell identifier. */
    key: text("key").notNull(),
    /** AES-256-GCM encrypted value: base64(iv).base64(tag).base64(ciphertext) */
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("project_env_vars_project_id_key").on(t.projectId, t.key)],
);

export type ProjectEnvVar = typeof projectEnvVarsTable.$inferSelect;
