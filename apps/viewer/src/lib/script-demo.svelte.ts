/**
 * Scripted demos — a catalog plus a script the console runs once it is loaded.
 *
 * This is story 3 of #14, authored demo sequences, offered from the welcome
 * screen. The script runs *in the console*, visibly, rather than behind the
 * scenes: the point of the demo is showing that every step of it is one line a
 * user could have typed, and the streaming transcript is what shows it.
 */
import { openTool } from './shell.svelte';

export interface ScriptDemo {
  readonly id: string;
  readonly label: string;
  readonly desc: string;
  /** The catalog to load first, as `loadDemo` names it. */
  readonly catalog: string;
  readonly source: string;
}

export const SCRIPT_DEMOS: readonly ScriptDemo[] = [
  {
    id: 'script-tour',
    label: 'Scripted Tour',
    desc: 'Earth + Moon driven line by line from the Script console — no kernels',
    // Kernel-free on purpose: it loads instantly, so the first thing a visitor
    // sees is the script running rather than a download bar.
    catalog: 'earth-moon',
    source: `# Every line is one ViewerControl call. Edit it and press Run.
setPlaying off
setTime 2024-07-04T12:00:00Z
viewpoint "Lunar Orbit"
displayNote "A script is driving this view" 3
wait 3

gotoObject Moon 2
displayNote "gotoObject Moon 2 - fly there over two seconds" 3
wait 3

setTimeRate 3600
setPlaying on
displayNote "setTimeRate 3600 - one hour per second" 4
wait 4

gotoObject Earth 2
wait 2
setFrame body-fixed Earth
displayNote "setFrame body-fixed Earth - the camera turns with the planet" 4
wait 4

setLayer labels off
displayNote "setLayer labels off" 2
wait 2
setLayer labels on
displayNote "Try Snapshot to turn what you see into a script"
`,
  },
];

/**
 * A script waiting for the console to pick it up.
 *
 * Handed over through state rather than a call, because the console does not
 * exist yet when the demo is chosen: it mounts only once the scene has
 * finished loading, which is also the earliest moment the script should run.
 */
export const pendingScript = $state({ source: null as string | null, autorun: false });

/** Queue a demo's script and open the console that will run it. */
export function queueScriptDemo(demo: ScriptDemo): void {
  pendingScript.source = demo.source;
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
