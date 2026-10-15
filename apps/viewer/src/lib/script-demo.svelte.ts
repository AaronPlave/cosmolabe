/**
 * Scripted demos — a catalog plus a script the console runs once it is loaded.
 *
 * This is story 3 of #14, authored demo sequences. A catalog index entry names
 * its script (`"script": "./earth-moon-tour.cosmo"`, see `catalog-sources`), so
 * a deployment offers scripted tours the same way it offers catalogs. The
 * script runs *in the console*, visibly, rather than behind the scenes: the
 * point of the demo is showing that every step of it is one line a user could
 * have typed.
 */
import { openTool } from './shell.svelte';

/**
 * A script waiting for the console to pick it up.
 *
 * Handed over through state rather than a call, because the console does not
 * exist yet when the demo is chosen: it mounts only once the scene has
 * finished loading, which is also the earliest moment the script should run.
 */
export const pendingScript = $state({ source: null as string | null, autorun: false });

/** Queue a script to run, and open the console that will run it. */
export function queueScript(source: string): void {
  pendingScript.source = source;
  pendingScript.autorun = true;
  openTool('script');
}

/** Take the queued script, if any, leaving nothing queued. */
export function takePendingScript(): { source: string; autorun: boolean } | null {
  if (pendingScript.source == null) return null;
  const taken = { source: pendingScript.source, autorun: pendingScript.autorun };
  pendingScript.source = null;
  pendingScript.autorun = false;
  return taken;
}

/**
 * Fetch an entry's script. Throws with the reason on a failed fetch, so the
 * caller reports it the way it reports a catalog that failed to load.
 */
export async function fetchScript(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`script ${url}: HTTP ${res.status}`);
  return res.text();
}
