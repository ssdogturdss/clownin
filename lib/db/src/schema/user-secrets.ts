import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * User-level secrets vault.
 *
 * Each row stores one named secret (e.g. "OPENAI_API_KEY") whose value is
 * AES-256-GCM encrypted with the same key used for project env vars.
 * Raw values are never returned to the client; they are only decrypted
 * server-side when injected into a project environment.
 */
export const userSecretsTable = pgTable(
  "user_secrets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // shell-identifier, e.g. "OPENAI_API_KEY"
    encryptedValue: text("encrypted_value").notNull(),
    description: text("description"), // optional human hint, stored in plain text
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("user_secrets_user_id_name").on(t.userId, t.name)],
);

export type UserSecret = typeof userSecretsTable.$inferSelect;
