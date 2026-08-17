import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

/** AI provider configuration — which provider is active and what API key to use. */
export const providerConfigsTable = pgTable("provider_configs", {
  id: serial("id").primaryKey(),
  /** Provider identifier: "openai" | "anthropic" | "gemini" | "openrouter" */
  provider: text("provider").notNull().unique(),
  displayName: text("display_name").notNull(),
  /** AES-256-GCM encrypted API key: base64(iv).base64(tag).base64(ciphertext) */
  encryptedApiKey: text("encrypted_api_key"),
  isActive: boolean("is_active").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProviderConfig = typeof providerConfigsTable.$inferSelect;
