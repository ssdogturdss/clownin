/**
 * AES-256-GCM encryption for project environment variable values.
 *
 * The 32-byte key is derived once from SESSION_SECRET via scrypt with a
 * fixed domain-separation salt. Values are never returned to clients raw —
 * the API decrypts them only to inject them into child processes.
 */

import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const SCRYPT_SALT = Buffer.from("clownin:env-vars:v1", "utf8");
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;

// Derived once on first use; avoids re-running scrypt on every encrypt/decrypt.
let _derivedKey: Buffer | null = null;

function getDerivedKey(): Buffer {
  if (_derivedKey) return _derivedKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set — required for env var encryption");
  }
  _derivedKey = scryptSync(secret, SCRYPT_SALT, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return _derivedKey;
}

/**
 * Encrypt a plaintext env var value.
 * Output format: `base64(iv).base64(authTag).base64(ciphertext)`
 */
export function encrypt(plaintext: string): string {
  const key = getDerivedKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

/**
 * Decrypt a stored env var value. Throws if the ciphertext is tampered with.
 */
export function decrypt(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted value format");
  const [ivB64, tagB64, ctB64] = parts;
  const key = getDerivedKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Malformed encrypted value");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
}

/**
 * Return a masked representation of a value for display.
 * We show up to the first 4 characters so users can identify which secret is set,
 * then replace the rest with bullets. Very short values are fully masked.
 */
export function maskValue(plaintext: string): string {
  if (plaintext.length <= 4) return "••••••••";
  const visibleChars = Math.min(4, Math.floor(plaintext.length / 4));
  return plaintext.slice(0, visibleChars) + "••••••••";
}

/**
 * Validate that a key is a legal shell/env-var identifier.
 * Allowed: letters, digits, underscores, must not start with a digit.
 */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.length > 0 && key.length <= 256;
}

/**
 * Reserved environment variable names that user-supplied values must never
 * override. Mirrors the local-execution allowlist that strips these keys from
 * the safeEnv object. Applied before any SSH shell-prefix helper.
 *
 * Blocking just these names is sufficient: the system-defined values of PATH,
 * HOME, etc. are already present in the remote shell; user values for them
 * would silently break command lookup and stdlib paths.
 */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  // Shell / command lookup
  "PATH", "HOME", "SHELL", "IFS", "PS1", "PS2", "PS4", "ENV", "BASH_ENV",
  // Locale
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  // Temp directories
  "TMPDIR", "TEMP", "TMP",
  // Python stdlib
  "PYTHONPATH", "PYTHONHOME",
  // Dynamic linker — security-critical, can inject arbitrary code
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  // Always forced by the serve machinery — must not be overridden
  "PORT",
]);

/**
 * Remove reserved keys from a user-supplied env map so system variables always
 * take precedence on the remote host, mirroring the safeEnv allowlist used in
 * local execution.
 */
export function filterUserEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !RESERVED_ENV_KEYS.has(k)),
  );
}

/**
 * Build a `KEY='value' ...` prefix string that can be prepended to a shell
 * command to inject env vars safely. Keys are validated; values are
 * single-quoted with embedded single-quotes escaped per POSIX.
 * Suitable for direct shell command prefixing (not for use inside a
 * sh -c '...' single-quoted argument — use buildBase64EnvSetup for that).
 */
export function buildShellEnvPrefix(envVars: Record<string, string>): string {
  const pairs = Object.entries(envVars)
    .filter(([k]) => isValidEnvKey(k))
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`);
  return pairs.length > 0 ? pairs.join(" ") + " " : "";
}

/**
 * Build shell setup commands that inject env vars via base64 decoding.
 *
 * This is specifically for use inside a `sh -c '...'` single-quoted argument
 * where single quotes cannot appear in the content. Base64 characters
 * (A-Za-z0-9+/=) are safe as unquoted shell arguments.
 *
 * Example output (prefix for a command):
 *   KEY1=$(printf %s BASE64_1 | base64 -d); export KEY1; KEY2=$(printf %s BASE64_2 | base64 -d); export KEY2;
 *
 * The calling convention:
 *   sh -c '${buildBase64EnvSetup(vars)}exec env PORT=... cmd'
 */
export function buildBase64EnvSetup(envVars: Record<string, string>): string {
  const entries = Object.entries(envVars).filter(([k]) => isValidEnvKey(k));
  if (entries.length === 0) return "";
  // printf %s avoids adding a trailing newline that would corrupt some values.
  // base64 -d is POSIX-available on all common Linux distributions.
  return entries
    .map(([k, v]) => {
      const b64 = Buffer.from(v, "utf8").toString("base64");
      return `${k}=$(printf %s ${b64} | base64 -d); export ${k};`;
    })
    .join(" ") + " ";
}
