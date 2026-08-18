-- Adds an optional model override column to provider_configs.
-- When NULL the server falls back to PROVIDER_DEFAULT_MODELS.

ALTER TABLE "provider_configs" ADD COLUMN IF NOT EXISTS "model" text;
