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
    label: 'Earth–Moon Scripted Tour',
    desc: "Adapted from the Cosmographia scripting example; demonstrates the equivalent Cosmolabe viewer-control workflow",
    // Kernel-free on purpose: it loads instantly, so the first thing a visitor
    // sees is the script running rather than a download bar.
    catalog: 'earth-moon',
    source: `# Adapted from the Cosmographia Earth–Moon scripting example
# (cosmoguide.org/scripting-example).
# Cosmolabe scripts are conceptually similar but are not source-compatible
# with Cosmographia's cosmoscripting Python API.
# Where the original uses something Cosmolabe has no verb for yet, a comment
# says so rather than faking it.

setPlaying off
setTime 2024-07-04T12:00:00Z
viewpoint "Lunar Orbit"
displayNote "A short trip to the Earth and the Moon" 4
wait 4
# cosmo.hideToolBar() - no equivalent; the shell's rail stays put.

gotoObject Earth 3
displayNote "Earth" 3
wait 3
setFrame body-fixed Earth
setTimeRate 1800
setPlaying on
displayNote "Body-fixed frame: the camera turns with the planet" 4
wait 4
setPlaying off

gotoObject Moon 3
displayNote "The Moon" 3
wait 3
setFrame body-fixed Moon
# cosmo.showBodyFixedFrame / showLatLongGrid - Cosmolabe's layers are
# scene-wide rather than per body.
setLayer axes on
setLayer grid on
displayNote "The Moon's body-fixed axes and latitude/longitude grid" 5
wait 5
# Not yet in Cosmolabe: showDirectionVector (directions to other bodies)
# and circleCenterUp (orbiting over the Moon's north pole).
setLayer grid off
setLayer axes off

viewpoint "Lunar Orbit"
setTimeRate 3600
setPlaying on
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
