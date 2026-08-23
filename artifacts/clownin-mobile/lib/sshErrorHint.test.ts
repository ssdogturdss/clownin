import { describe, it, expect } from 'bun:test';
import { getConnectionHint, getErrorLabel } from './sshErrorHint';

describe('getConnectionHint', () => {
  it('returns a firewall hint for ECONNREFUSED', () => {
    const hint = getConnectionHint('connect ECONNREFUSED 192.168.1.1:22');
    expect(hint).toBe('Port 22 is closed — check your firewall or port forwarding');
  });

  it('returns a DNS hint for ENOTFOUND', () => {
    const hint = getConnectionHint('getaddrinfo ENOTFOUND example.invalid');
    expect(hint).toBe('Hostname not found — check the IP or domain');
  });

  it('returns a handshake hint for readyTimeout', () => {
    const hint = getConnectionHint('Error: Timed out while waiting for handshake');
    expect(hint).toBe('Connected but SSH handshake timed out — try adding UseDNS no to /etc/ssh/sshd_config on the server');
  });

  it('returns a handshake hint for explicit handshake keyword', () => {
    const hint = getConnectionHint('SSH handshake failed');
    expect(hint).toBe('Connected but SSH handshake timed out — try adding UseDNS no to /etc/ssh/sshd_config on the server');
  });

  it('returns a credentials hint for Authentication failure', () => {
    const hint = getConnectionHint('Authentication failed for user root');
    expect(hint).toBe('Wrong username or password');
  });

  it('returns null for unknown errors', () => {
    const hint = getConnectionHint('Something completely unexpected happened');
    expect(hint).toBeNull();
  });
});

describe('getErrorLabel', () => {
  it('returns the raw error when present', () => {
    expect(getErrorLabel('connect ECONNREFUSED')).toBe('connect ECONNREFUSED');
  });

  it('falls back to "Connection failed" for undefined', () => {
    expect(getErrorLabel(undefined)).toBe('Connection failed');
  });

  it('falls back to "Connection failed" for empty string', () => {
    expect(getErrorLabel('')).toBe('Connection failed');
  });

  it('falls back to "Connection failed" for whitespace-only string', () => {
    expect(getErrorLabel('   ')).toBe('Connection failed');
  });
});
