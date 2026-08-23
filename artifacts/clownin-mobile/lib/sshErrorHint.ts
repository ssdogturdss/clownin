/**
 * Maps a raw SSH error string to a user-friendly hint.
 * Returns null only for recognised errors that already carry enough context
 * in the raw message — callers must always show *something* even when null
 * is returned (use the raw message or the generic fallback).
 */
export function getConnectionHint(error: string): string | null {
  if (error.includes('ECONNREFUSED'))
    return 'Port 22 is closed — check your firewall or port forwarding';
  if (error.includes('ENOTFOUND'))
    return 'Hostname not found — check the IP or domain';
  if (
    error.includes('handshake') ||
    error.includes('readyTimeout') ||
    error.includes('Timed out')
  )
    return 'Connected but SSH handshake timed out — try adding UseDNS no to /etc/ssh/sshd_config on the server';
  if (
    error.includes('Authentication') ||
    error.includes('password') ||
    error.includes('auth')
  )
    return 'Wrong username or password';
  return null;
}

/**
 * Returns visible badge label text for a failed connection.
 * Never returns an empty string: falls back to "Connection failed".
 */
export function getErrorLabel(error: string | undefined): string {
  return error?.trim() || 'Connection failed';
}
