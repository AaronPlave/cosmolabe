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
    source: `# Adapted from the Cosmographia Earth–Moon scripting example.
# Cosmolabe scripts are conceptually similar but are not source-compatible
# with Cosmographia's cosmoscripting Python API.
#
# Each block follows one block of the original, with its displayNote/wait
# pacing. Where Cosmolabe has no equivalent, a "No equivalent yet" comment
# names the Cosmographia call; where the equivalent is approximate, a comment
# says how.
#
# Camera poses: setCamera takes the viewer's scene axes, which are Y-up.
# A body-fixed vector [x, y, z] from the original is written [x, z, -y].
# Cosmographia animates its camera moves; setCamera and pointAtObject are
# instant, so the waits the original spent animating are pauses here.

displayNote "Welcome to the Cosmolabe scripting example!" 3
wait 4

# hideToolBar / hideStatusMessages / hideInfoText / showFullScreen
# No equivalent yet: scripts cannot hide viewer chrome or go full screen.
displayNote "Switch to full screen, hide toolbar and info text" 3
wait 4

# setCameraToInertialFrame -> free orbit, Cosmolabe's inertial camera.
# gotoHome(5) -> the scene's widest named viewpoint (no animated home view yet).
displayNote "Start with the home view" 3
wait 1
setFrame free-orbit
setTimeRate 1
setPlaying on
viewpoint "Lunar Orbit"
wait 6

displayNote "Set time to 2015-10-31 23:50 UTC" 2
wait 2
setTime 2015-10-31T23:50:00Z
wait 1

displayNote "Fly to Earth" 3
wait 1
gotoObject Earth 5
wait 6

# moveAwayFromCenter(10000, 3) / circleCenterRight(360, 5)
# No equivalent yet: no dolly or orbit moves. (A full 360-degree circle ends
# where it started, so the view after this block matches the original.)
displayNote "Back up a bit and fly around Earth" 3
wait 10

# moveToPov("Earth", [0,-14000,11500], [0,1.4,-1.15], [0,0,1], 5):
# the body-fixed frame, then the same pose in scene axes, looking at the centre.
displayNote "Look down at North America" 3
wait 1
setFrame body-fixed Earth
setCamera [0, 11500, 14000] [0, 0, 0] [0, 1, 0]
wait 6

displayNote "Point at the Sun" 3
wait 1
pointAtObject Sun
wait 3

displayNote "Point at the Moon" 3
wait 1
pointAtObject Moon
wait 3

# moveToPov("Moon", [5000,0,0], [-1,0,0], [0,0,1], 5)
displayNote "Fly to the Moon and look at its near side" 4
wait 1
clearLookAt
gotoObject Moon 5
wait 5
setFrame body-fixed Moon
setCamera [5000, 0, 0] [0, 0, 0] [0, 1, 0]
wait 1

# showBodyFixedFrame("Moon") / showLatLongGrid("Moon"): Cosmolabe's axes and
# grid layers are scene-wide rather than per body.
displayNote "Show Moon's frame and lon-lat grid" 2
wait 1
setLayer axes on
wait 1
setLayer grid on
wait 1
# showDirectionVector("Moon", "Sun") / ("Moon", "Earth")
# No equivalent yet: no direction vectors.
displayNote "Show directions to Sun and Earth" 2
wait 3

# circleCenterUp(90, 2.5) -> the pose it ends on: over the north pole.
displayNote "Look at the Moon's North pole" 3
wait 1
setCamera [0, 5000, 0] [0, 0, 0] [-1, 0, 0]
wait 3.5

# circleCenterDown(180, 5) -> over the south pole.
displayNote "Look at the Moon's South pole" 3
wait 1
setCamera [0, -5000, 0] [0, 0, 0] [1, 0, 0]
wait 6

# circleCenterUp(90, 2.5) + circleCenterRight(180, 5) -> over the far side.
displayNote "Look at the Moon's far side" 3
wait 1
setCamera [-5000, 0, 0] [0, 0, 0] [0, 1, 0]
wait 8.5

# craneUp(2000, 2) -> the same view raised 2000 km along the camera's up.
displayNote "Look over the Moon's shoulder at the Earth" 3
wait 1
setCamera [-5000, 2000, 0] [0, 2000, 0] [0, 1, 0]
wait 3

# trackObject("Earth") keeps the Moon-Earth direction fixed while the camera
# stays on the Moon. In Cosmolabe that is pointAtObject; our "track" would
# re-centre on Earth instead.
displayNote "Switch view to track Earth" 3
wait 4
pointAtObject Earth
displayNote "Speed up time to see the sky pass behind it" 3
setTimeRate 86400
wait 7

# pause() / unpause() -> setPlaying off / on
displayNote "Stop time and point at the Sun" 3
wait 1
setPlaying off
wait 2
pointAtObject Sun
wait 3
setPlaying on

displayNote "Go back to the home view" 3
wait 1
clearLookAt
setFrame free-orbit
setTimeRate 1
viewpoint "Lunar Orbit"
wait 7

# hideBodyFixedFrame / hideLatLongGrid -> the layers off again.
# hideDirectionVector, showToolBar, showStatusMessages, showInfoText,
# showNormalWindow: nothing to undo here.
displayNote "Restore changed settings" 3
setLayer axes off
setLayer grid off
wait 4

displayNote "It was fun! Goodbye ..." 3
wait 3
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
