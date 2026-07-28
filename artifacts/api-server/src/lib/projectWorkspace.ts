/**
 * Per-project persistent working directories in /tmp.
 *
 * Each project gets /tmp/clownin-projects/<id>/ where ALL its files are synced
 * before every execution. This means:
 *   - require('./utils') works across multiple files
 *   - node_modules/ from npm install persists within the server session
 *   - Python imports work across files in the same directory
 */
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";

const BASE = join(tmpdir(), "clownin-projects");

export function projectDir(projectId: number): string {
  return join(BASE, String(projectId));
}

export async function syncProjectFiles(
  projectId: number,
  files: Array<{ path: string; content: string }>
): Promise<string> {
  const dir = projectDir(projectId);
  await mkdir(dir, { recursive: true });

  for (const f of files) {
    // Sanitise path — no escaping the project dir
    const safe = f.path.replace(/\.\.\//g, "").replace(/^\//, "");
    const abs = join(dir, safe);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf8");
  }

  return dir;
}
