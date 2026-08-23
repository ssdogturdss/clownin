export type ServerTestResult = { ok: boolean; error?: string; testedAt: number };

/**
 * Remove one server's test result from the results map, leaving all others
 * intact.  Called when the user opens a server's edit form so stale badge data
 * does not outlive the configuration it describes.
 */
export function clearServerTestResult(
  results: Record<number, ServerTestResult>,
  serverId: number,
): Record<number, ServerTestResult> {
  const { [serverId]: _removed, ...rest } = results;
  return rest;
}
