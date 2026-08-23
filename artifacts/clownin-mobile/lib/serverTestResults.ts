import AsyncStorage from '@react-native-async-storage/async-storage';

export type ServerTestResult = { ok: boolean; error?: string; testedAt: number };

/** One AsyncStorage key per server — no shared blob, no read-modify-write races. */
const keyFor = (serverId: number) => `clownin_stest_${serverId}`;

/**
 * Remove one server's test result from the in-memory results map, leaving all
 * others intact.  Called when the user opens a server's edit form so a stale
 * badge does not outlive the configuration it describes.
 */
export function clearServerTestResult(
  results: Record<number, ServerTestResult>,
  serverId: number,
): Record<number, ServerTestResult> {
  const { [serverId]: _removed, ...rest } = results;
  return rest;
}

/**
 * Load persisted test results from AsyncStorage in a single multiGet call,
 * filtered to only the server IDs that currently exist so a removed server
 * cannot bleed its result onto a future server that happens to reuse the same ID.
 */
export async function loadPersistedTestResults(
  serverIds: number[],
): Promise<Record<number, ServerTestResult>> {
  if (serverIds.length === 0) return {};
  try {
    const keys = serverIds.map(keyFor);
    const pairs = await AsyncStorage.multiGet(keys);
    const out: Record<number, ServerTestResult> = {};
    for (const [key, value] of pairs) {
      if (!value) continue;
      const id = Number(key.replace('clownin_stest_', ''));
      try {
        out[id] = JSON.parse(value);
      } catch {
        // Corrupt entry — skip silently.
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist a single server's test result so it survives app restarts.
 * Each server has its own key so concurrent writes cannot overwrite one another.
 */
export async function persistTestResult(
  serverId: number,
  result: ServerTestResult,
): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(serverId), JSON.stringify(result));
  } catch {
    // Storage failures are non-fatal; the in-memory result is still shown.
  }
}

/**
 * Remove a server's persisted test result.  Call when the server is deleted or
 * its edit form is opened so the stale badge does not reappear on next launch.
 * Each server has its own key so this operation cannot affect other servers.
 */
export async function removePersistedTestResult(serverId: number): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(serverId));
  } catch {
    // ignore
  }
}
