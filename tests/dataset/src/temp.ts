/**
 * Temporary folders. Each one is removed when its work ends, and all that are
 * left are removed when the tool is interrupted.
 */

const live = new Set<string>();

export async function makeTempFolder(label: string): Promise<string> {
  const folder = await Deno.makeTempDir({ prefix: `wfinfo-dataset-${label}-` });
  live.add(folder);
  return folder;
}

export async function removeTempFolder(folder: string): Promise<void> {
  live.delete(folder);
  await Deno.remove(folder, { recursive: true }).catch(() => {});
}

export function removeAllTempFolders(): void {
  for (const folder of live) {
    try {
      Deno.removeSync(folder, { recursive: true });
    } catch {
      // already gone
    }
  }
  live.clear();
}
