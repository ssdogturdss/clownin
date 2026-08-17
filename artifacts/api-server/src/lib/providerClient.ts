/**
 * Provider client factory.
 *
 * Resolves the active AI provider from the DB (30-second TTL cache) and falls
 * back to env-var credentials when no DB provider is configured or when
 * decryption fails.
 *
 * Caching rules:
 *  - Only successful DB decryptions are cached.
 *  - A decrypt error does NOT populate the cache; the corrected key is picked
 *    up on the very next request.
 *  - A DB error also does NOT populate the cache; requests fall through to the
 *    env-var fallback immediately.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { db, providerConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decrypt } from "./envCrypto.js";

// ── OpenAI-compatible base URLs (Anthropic uses its own SDK) ─────────────────
export const PROVIDER_BASE_URLS: Record<string, string> = {
  openai:     "https://api.openai.com/v1",
  gemini:     "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
};

// ── Default model names per provider ─────────────────────────────────────────
export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai:     "gpt-5.6-terra",
  anthropic:  "claude-opus-4-5",
  gemini:     "gemini-2.0-flash",
  openrouter: "openai/gpt-4o",
};

export interface ProviderClientResult {
  provider: string;
  model: string;
  /** Set for OpenAI-compatible providers (openai, gemini, openrouter) */
  openaiClient?: OpenAI;
  /** Set only when provider === "anthropic" */
  anthropicClient?: Anthropic;
}

interface CachedProvider {
  provider: string;
  apiKey: string;
  baseURL: string;
  model: string;
  expiresAt: number;
}

let _providerCache: CachedProvider | null = null;

/** Exposed only for unit tests — resets the in-process cache between test cases. */
export function _resetProviderCacheForTests(): void {
  _providerCache = null;
}

/**
 * Fallback: Replit AI integration env vars (OpenAI-compatible), then bare
 * OPENAI_API_KEY. Never cached so that a newly-configured DB provider takes
 * effect on the very next request rather than being stuck behind a cache window.
 */
export function getEnvVarFallback(): ProviderClientResult {
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??
    process.env.OPENAI_API_KEY;
  const baseURL =
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
    "https://api.openai.com/v1";

  if (!apiKey) {
    throw new Error(
      "No AI provider configured — set an active provider in the admin panel or configure OPENAI_API_KEY",
    );
  }

  return buildResult("openai", apiKey, baseURL, "gpt-5.6-terra");
}

export async function getProviderClient(): Promise<ProviderClientResult> {
  const now = Date.now();

  // Return cached DB-sourced entry if still fresh
  if (_providerCache && now < _providerCache.expiresAt) {
    return buildResult(
      _providerCache.provider,
      _providerCache.apiKey,
      _providerCache.baseURL,
      _providerCache.model,
    );
  }

  // Query DB for the active provider
  try {
    const [active] = await db
      .select()
      .from(providerConfigsTable)
      .where(eq(providerConfigsTable.isActive, true))
      .limit(1);

    if (active && active.encryptedApiKey) {
      // Decrypt separately so a corrupt/expired key does not get cached and
      // is retried on the very next request rather than being served stale.
      let apiKey: string;
      try {
        apiKey = decrypt(active.encryptedApiKey);
      } catch (decryptErr) {
        // Key is corrupt or was encrypted with a different secret.
        // Log with a distinct code so operators can find this in logs quickly.
        // Do NOT populate the cache — a corrected key must take effect immediately.
        console.error(
          "[PROVIDER_DECRYPT_ERROR] Failed to decrypt API key for active provider '%s'. " +
            "Requests are falling back to the env-var provider until the key is fixed in the admin panel.",
          active.provider,
          decryptErr,
        );
        return getEnvVarFallback();
      }

      const baseURL = PROVIDER_BASE_URLS[active.provider] ?? "https://api.openai.com/v1";
      const model   = PROVIDER_DEFAULT_MODELS[active.provider] ?? "gpt-5.6-terra";
      _providerCache = {
        provider: active.provider,
        apiKey,
        baseURL,
        model,
        expiresAt: now + 30_000,
      };
      return buildResult(active.provider, apiKey, baseURL, model);
    }

    // No active DB provider — clear any stale cache so next request re-queries
    _providerCache = null;
  } catch (err) {
    // DB error — clear cache and fall through to env-var fallback
    _providerCache = null;
    console.warn("[agent] Failed to load provider config from DB:", err);
  }

  return getEnvVarFallback();
}

export function buildResult(
  provider: string,
  apiKey: string,
  baseURL: string,
  model: string,
): ProviderClientResult {
  if (provider === "anthropic") {
    return { provider, model, anthropicClient: new Anthropic({ apiKey }) };
  }
  return { provider, model, openaiClient: new OpenAI({ apiKey, baseURL }) };
}
