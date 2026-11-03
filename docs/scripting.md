# Scripting and host control

Cosmolabe exposes one control surface, `ViewerControl`, and three ways to reach
it: the typed interface, a `verb arg…` text language, and a verb table a command
palette can render. They are the same vocabulary — the table is the source, the
other two are derived from it.

| Face | For | Gets |
|---|---|---|
| the typed interface | embed / host control | the full surface, structured arguments, reads and events; loops come from the host's own JavaScript |
| the text language | scene setup, saved programs, visual-regression goldens | no eval, checked in, safe to hand a stranger |
| the verb table | command palette, keymap | one vocabulary, derived rather than restated |

Everything lives in [`@cosmolabe/control`](../packages/control), a package with no runtime imports
of the domain model or renderer with no DOM and no renderer in it. The viewer's implementation is one
file, [`apps/viewer/src/lib/viewer-control.ts`](../apps/viewer/src/lib/viewer-control.ts).

## What this API asserts

**Cosmolabe is a controllable visualization surface, not an authoritative
mission-state system.** External systems stay the source of truth; we render,
and we derive view state from what they tell us. A later integration is an
adapter over this same contract rather than a set of new concepts inside it —
the shape the SPICE swap already proved out.

That is why the port carries reads as well as writes, and why `snapshot()`
returns a *script* rather than a bespoke state document: everything the viewer
knows about its own view is expressible in the vocabulary a host can drive it
with.

## The interface is the contract; `window.cosmo` is one binding

```ts
import { createViewerControl } from '$lib/viewer-control';

const cosmo = createViewerControl();   // an embed, a test, an integration
```

The viewer also assigns one to `window.cosmo`, next to `window.renderer`, so the
browser console can drive it. That is a convenience: nothing in the design
requires a global, and no method reaches for one.

From the console, JavaScript supplies the loops and variables — the same
division Cosmographia makes with Python:

```js
for (const body of ['Titan', 'Enceladus', 'Dione']) {
  await cosmo.gotoObject(body);
  await cosmo.wait(1);
  cosmo.screenshot(body);
}
```

## The language

One statement per line, `verb arg…`. That is what makes a reported line number
exact by construction rather than by bookkeeping.

```
setPlaying off
setTime 2004-10-26T15:30:00Z
gotoObject Titan
setFrame body-fixed Titan
showTrajectory Cassini on
setLayer labels off
displayNote "T-A flyby - Titan body-fixed"
```

### Tokens

| | |
|---|---|
| **Strings** | Bare, or `"quoted"` for anything with a space: `viewpoint "SOI (2004-07-01)"`. `\"` and `\\` are the escapes. |
| **Numbers** | Decimal only, exponent allowed: `-2.5`, `1e3`. `0x10` and `1_000` are not numbers and are rejected by whichever parameter wanted one. |
| **Vectors** | `[x, y, z]`, commas optional: `[0, 0, 0.01]`, `[0 0 0.01]`. Exactly three components. |
| **Booleans** | `on`, `off`, `true`, `false`. |
| **Times** | A bare 4-digit integer is a **calendar year**; any other numeric token is an **ephemeris time** (seconds past J2000); anything else is a calendar string handed to the viewer, which resolves it through SPICE's `str2et` where kernels are furnished and through core's leap-second-exact calendar parse where they are not. |
| **Comments** | `#` to end of line, outside quotes. |

Verb names are **case-sensitive** — there is one vocabulary, shared with the
palette. A case-folded lookup runs only to build `did you mean "gotoObject"?`
after the exact one has already failed. Object names are passed **verbatim**:
`Universe.getBody` is an exact-match lookup on a `Map`, and folding case here
would invent a resolver that exists nowhere else.

### Errors

`parse` collects **every** problem and throws one `ScriptSyntaxError`; fixing a
twenty-line script should not be a twenty-run job.

```
line 3: unknown verb "gotoobject" (did you mean "gotoObject"?)
line 5: setFov: <degrees> expected a number, got "wide"
```

`execute` stops at the **first** runtime error and throws a
`ScriptRuntimeError`. A half-applied scene still renders and still looks
plausible, which is exactly how a confident picture of the wrong thing gets
committed as a golden.

```
line 3: gotoObject: no object named "Titam" (did you mean "Titan"?)
```

A verb whose method the host does not implement is an error at that statement,
never a silent skip: a script that "succeeds" with no recording and no
screenshot to show for it is worse than one that fails.

### Deliberately absent

Variables, expressions, control flow, user-defined verbs, `include`, a
`run <program>` verb — that last one is recursion, and the no-eval line is drawn
there — and any `eval`. A host that wants a loop writes JavaScript against
`ViewerControl`.

### `runTo` versus `wait`

These are not interchangeable, and the difference is the whole safety property
of a scripted capture:

- **`runTo <seconds>`** advances *scene* time by an exact amount. Deterministic.
  It is also the primitive most Cosmographia loops exist to express.
- **`wait <seconds>`** is a *wall-clock* settle for streamed textures and
  terrain. It touches no scene state, and it means something different in a
  browser (a sleep) than in an offscreen harness (N rendered frames).

Anywhere a frame has to be reproducible, `wait` is rejected outright, naming the
line. A golden that depends on wall-clock is a coin flip: at Saturn orbit
insertion Cassini covers 29.8 km/s, so a 6 s settle drifts the scene ~180 km.

## Verbs

### Scene

| Verb | |
|---|---|
| `gotoObject <object> [seconds]` | Cosmographia's name for `jumpTo`. **Cuts by default**; give seconds to fly there directly. |
| `select <object>` | Select an object — what the info panel shows. Never moves the camera. |
| `deselect` | Clear the selection. |

`gotoObject` does not animate unless asked, because a fly-to is a wall-clock
animation that only installs the new origin body on completion: a caller that
renders one frame and photographs it gets the camera mid-flight.

### Navigation

Select, Track, Frame, Fly and Jump are the one navigation vocabulary every
surface of the viewer shares; [navigation.md](navigation.md) defines them. None
implies another: `select` never moves the camera, and none of these selects.

| Verb | |
|---|---|
| `track <object>` | Make an object the camera's anchor — what it orbits and follows — **without moving the camera**. It turns to face the object. |
| `untrack` | Release it. The camera stays where it is. |
| `frameObject [object]` | Cut to a view that fits an object (the tracked one when omitted), and track it. |
| `flyTo <object> [path] [seconds]` | Fly to the view `frameObject` would cut to, and track the object. `<path>` is `direct` (the default) or `overview` (pull back to show both ends, then approach). Returns at once; follow with `wait`. |
| `jumpTo <object>` | Cut to the view a flight would land on, and track the object. |
| `stopFlight` | End a flight where it is, tracking what it was flying to (the camera turns to face it). |
| `gotoCoordinates <object> <latitude> <longitude> [view] [seconds]` | Go to a place on a body: planetocentric latitude and east longitude in degrees, viewed `overhead` (the default), `oblique` or from the `surface`. **Cuts by default**; give seconds to fly. The place becomes the orbit pivot; time and selection are left alone. `ViewerControl.gotoCoordinates` also takes planetographic latitude, west longitude and a range. See [navigation](navigation.md#surface-navigation). |

| `gotoPlace <place> [fly\|jump]` | Go to a named place (a Gazetteer name or mission site) by its stable ref, and select it. **Flies by default**. Framed overhead by the place's own extent, never by the Navigate panel's form, and without opening that panel. See [places](#places-and-imagery). |

The path comes before the duration, so `flyTo Titan 3` is an error (`3` is not
a path); write `flyTo Titan overview 3`. Manual input — a drag, a wheel zoom, a
movement key — also ends a flight where it is; the `flightEnd` notification
says which way each flight ended.

### Camera

| Verb | |
|---|---|
| `pointAtObject <object>` | Aim at an object while still orbiting what is tracked. Idempotent — it does not toggle. |
| `clearLookAt` | Stop aiming at an object. |
| `viewpoint <name>` | Apply a named catalog viewpoint, seeking the clock if it declares an epoch. |
| `setFrame <mode> [object]` | Switch camera frame, optionally onto an object. |
| `setCamera <position> [target] [up]` | Place the camera: eye, the point it looks at, and up — all in km, in the camera frame's axes (below). |
| `setFov <degrees>` | Vertical field of view. |
| `dolly <km> [seconds]` | Move the camera straight away from what it orbits (toward it if negative), keeping its aim. Stops short of the centre, and a body's surface still stops it. |
| `crane <km> [seconds]` | Raise the camera and the point it looks at together along the view's up (lower if negative), so the same view slides up the screen. |
| `circleCenterRight <degrees> [seconds]` | Swing the camera around what it orbits, keeping its distance and aim. Also `circleCenterLeft`, `circleCenterUp`, `circleCenterDown`. Instant by default; give seconds to animate. |
| `composeView <anchor> <target> [also]` | Swing the camera around the tracked anchor (with `circleCenter*`) until the target, and `also`, sit beside it in the frame. Keeps distance, clock and selection. Refuses without moving when the anchor fills the view; fails when a nearer body hides the target. Needs `getViewComposition`. |

`setCamera` takes eye, target and up in that order — the same order catalog
`Viewpoint` JSON and `camera-view-io.ts` already use.

**Which axes.** In a `body-fixed` or `sc-fixed` frame the vectors are in that
body's own frame, relative to its centre: Z is the pole and X the prime meridian,
the SPICE convention and the one Cosmographia's `moveToPov` uses. So
`setFrame body-fixed Earth` then `setCamera [0, -14000, 11500] [0, 0, 0] [0, 0, 1]`
looks down on North America (39.4°N, 90°W) whatever time it is. In every other
frame they are world (ecliptic J2000) vectors. `getCamera()` and `snapshot()`
report the pose in the same axes, so a snapshot replays to the same view. `target` is not optional
decoration: position and up alone say where the camera stands and nothing about
what it sees.

`setCamera` sets a **pose and nothing else**. It does not clear what is tracked
or what is being pointed at, and both keep acting on the camera afterwards:
while an object is tracked the pose is relative to it, and while `pointAtObject`
is in effect the aim follows that object and overrides `target` on the next
frame. Call `untrack` / `clearLookAt` first if the pose should stand alone.

`dolly` and `crane` are exact versions of moves the viewer already has: the
mouse wheel's zoom, and the Z / C keys. Like Z / C, a `crane` in free orbit
releases the tracked object first: tracking pins the orbit centre to the
object every frame, which would turn the crane into a tilt. Body-fixed and
spacecraft-fixed frames keep tracking. Timing and refusal are the same as the
`circleCenter*` moves below.

The `circleCenter*` moves are named for the way the camera moves on screen.
Right and left swing it about the view's up vector; up and down swing it about
the view's right axis and carry the up vector along, so the view never rolls.
They pivot on the orbit target (the tracked object, or the point `setCamera`
aimed at) and work in the orbit-controlled frames: `free-orbit`, `body-fixed`
and `sc-fixed`. The other frames own the view's direction, so there the viewer
refuses the move. A timed move is a rotation at a constant rate, not an
interpolation between two poses, because a full circle starts and ends at the
same pose. Like a timed `gotoObject` it returns at once, so follow it with
`wait` to let it play. A later `setCamera` stops it.

`<mode>` is one of `free-orbit`, `sc-fixed`, `body-fixed`, `lvlh`, `chase`,
`surface`, `surface-explorer`, `instrument`.

`setFrame` frames the named object (as `frameObject`) **before** switching mode. Asking for
body-fixed/Mars while still tracking Cassini would otherwise give a camera
locked to Mars's rotation but orbiting Cassini — a picture that looks plausible
and is wrong.

### Display

| Verb | |
|---|---|
| `setObjectVisible <object> on\|off` | Mesh, trajectory, label, sensors and all. |
| `showTrajectory <object> on\|off` | One object's trajectory line. |
| `showLabel <object> on\|off` | One object's label. |
| `setLayer <layer> on\|off` | A whole layer at once. |
| `showImagery <object> <layer> on\|off` | One layer of a body's streamed imagery stack, by layer ID. The base layer stays on. |
| `setImageryOpacity <object> <layer> <opacity>` | One imagery layer's opacity, 0 to 1. |
| `displayNote <text> [seconds]` | Caption over the viewport. Omit the duration to leave it up. |

`<layer>` is one of `trajectories`, `labels`, `grid`, `axes`, `sensors`,
`sensorLabels`. `setLayer` does **not** write the user's saved display
preferences — a script driving the view should not change what the person set in
the Display panel and will see again next visit.

### Time

| Verb | |
|---|---|
| `setTime <when>` | Seek the clock. |
| `setTimeRate <rate>` | Scene-seconds per wall-second. |
| `setPlaying on\|off` | Start or stop playback. |
| `runTo <seconds>` | Advance scene time by exactly this much. |

### Sequencing and output

| Verb | |
|---|---|
| `wait <seconds>` | Wall-clock settle. Not deterministic; see above. |
| `screenshot [label]` | Capture the current frame. |
| `record on\|off` | Start or stop video recording. Idempotent in both directions. |

## The script console

The viewer's **Script** tool (rail, or <kbd>`</kbd>) is a lightweight sequence
runner for the text language, not an embedded IDE. It is a shell panel rather
than a dialog, so the scene it drives stays visible while a script runs.

### The editor is the execution view

The editor (CodeMirror 6) shows line numbers, and during a run it marks the
statement running with a thin rail. Finished lines step back, and a failed or
stopped line is marked in the error or warning colour. A running `wait` shows
its countdown at the end of its line. Below the editor there is only what the
editor cannot show: a status line with real progress (`RUNNING · 5 / 17 ·
wait 3 · 1.8s remaining`, counting statements, not lines), a thin progress bar,
and any problems. Clicking a problem jumps to its line. The source is
read-only while a script is running or paused, so the marks always refer to the
program being executed; editing after a run clears them.

Editing is language-aware, and all of it comes from `@cosmolabe/control`
(`cursorContext`, `completionsAt`, `signatureAt`), so the editor cannot disagree
with the interpreter:

- **Completion.** Verbs at the start of a line; then each argument's values:
  enum ids (`setFrame body-fixed`), `on`/`off`, and the loaded scene's own
  object and viewpoint names, quoted when they need it.
- **Signature help.** The current line's usage, with the parameter under the
  cursor emphasised, plus the verb's one-line help.
- **Lint.** `parse` runs as you type and underlines every problem it would
  report, before you press Run.

### Running

| State | Controls | Status |
|---|---|---|
| Idle | **Run** (<kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd>), Snapshot | |
| Running | **Pause**, Stop | `RUNNING · 5 / 17 · wait 3 · 1.8s remaining` |
| Paused | **Resume**, Step, Stop | `PAUSED · 5 / 17` |
| Finished | **Run again**, Snapshot | `✓ Completed · 17 steps · 26.4s` |

- **Pause** means *after the current statement*: the runner holds `execute`'s
  `beforeStatement` gate, and the rail moves to the statement that runs next.
  Nothing in flight is frozen; a camera fly-to cannot honestly be paused
  mid-way. The exception is `wait`, which is the runner's own timer: a paused
  `wait 60` stops counting at once and resumes with the time it had left.
- **Step** runs exactly one statement (or finishes a held `wait`), then pauses
  again.
- **Stop** is immediate, even in the middle of a `wait`: the run stops awaiting
  the statement in flight, and a recording the script started is stopped then
  and there.
- Pausing a script does not pause scene time. The timeline has its own
  play/pause; the script controls are labelled "script" to keep the two apart.

A run ends with the console. Closing the panel, or loading a catalog (which
replaces the whole workspace), stops the script at once. Minimizing the panel
does not.

Hosts get the same control through `execute(program, host, { signal,
beforeStatement })`. `signal` is an `AbortSignal` or anything with its `aborted`
flag and `abort` listeners; the host call in flight is abandoned rather than
undone, and a statement that already finished synchronously counts as run.
`beforeStatement` is an awaited gate before each statement, which is all
Pause and Step are.

### Snapshot, programs and reference

- **Snapshot** replaces the editor with `cosmo.snapshot()`, a script that
  reproduces the current view.
- **Programs** live in the panel header (`Untitled ▾`): save, save under a new
  name, load, delete. They are kept in `localStorage` under
  `cosmolabe-viewer-scripts`, separate from the display preferences. If what is
  stored there cannot be read, saving is disabled rather than risk overwriting
  it. A save the browser refuses (for example, storage is full) is reported and
  stays on screen until a later write succeeds.
- **Verb reference** is collapsed by default and derived from `VERB_LIST`.

Keys pressed inside the console stay in it. Escape from the editor closes
whatever the editor has open, and otherwise just leaves the editor; it does not
close the panel from there.

### The Earth–Moon Scripted Tour

The **Earth–Moon Scripted Tour** on the home screen loads the base library's
Earth system on the real kernels (`test-catalogs/earth-moon-tour.json` requires
`base/earth-system.json`: de440s for where Earth and the Moon were on
2015-10-31, pck00011 for how they were turned), so the body-fixed views land on
the geography the original script aims at, and runs an adaptation
of Cosmographia's Earth–Moon scripting example in the console, block by block
with the original's notes and pacing. The
`circleCenter*`, `moveAwayFromCenter` and `craneUp` moves carry over as
`circleCenter*`, `dolly` and `crane`. `moveToPov`, which Cosmolabe cannot
animate yet, becomes an instant `setCamera` pose at the position the original
ends on. Calls with no equivalent are left as "No equivalent yet" comments; the
table under [Not yet in Cosmolabe](#not-yet-in-cosmolabe) lists them.
Cosmolabe scripts are conceptually similar to Cosmographia's but are not
source-compatible with its `cosmoscripting` Python API. The script is
`apps/viewer/test-catalogs/earth-moon-tour.cosmo`, attached to its catalog by the
`script` field of an index entry (see [catalog-sources.md](catalog-sources.md)),
so a deployment offers scripted tours the same way it offers catalogs. A unit
test parses every script the Examples index names against the verb table.

## The read side

```ts
cosmo.getTime();          // seconds past J2000
cosmo.getRate();
cosmo.isPlaying();
cosmo.getSelected();      // string | null
cosmo.getTracked();
cosmo.getFlight();        // { id, target, path } while a flight plays, else null
cosmo.getCamera();        // { position (km), up, fov }
cosmo.listObjects();
cosmo.listViewpoints();
cosmo.getCamera();        // { position, target, up, fov } — all in km

cosmo.getObjectState('SC-1', { frame: 'J2000', center: 'Earth' }); // position, attitude, availability
cosmo.getSpatialContext('SC-1'); // current epoch, parent fixed-frame state, shape/conventions, editable target
cosmo.projectGroundPoint('SC-1', 'reference'); // read-only radial sub-point; rendered/terrain also supported
cosmo.pinGroundPoint('SC-1', 'rendered'); // transient native Point Probe snapshot; no camera/clock change
cosmo.getProbePoint(); // point, placement epoch, fresh native draw observation, Draw-compatible annotation coords
cosmo.clearProbePoint(); // persistent geographic annotation edits remain separate authoring operations
cosmo.getTimelineWindow();  // { start, end } ET; setTimelineWindow(start, end) navigates it

cosmo.getScene();         // { id, catalog, ready } — id changes with every scene bound; null with none

const off = cosmo.on('select', ({ name }) => …);
// also 'time' ({ et, cause }), 'playback', 'load', 'ready', 'activities', 'activitySelect',
// 'cameraInput' ({}) — manual navigation, including between flights
// 'flightEnd' ({ id, target, path, outcome: 'arrived' | 'stopped' | 'interrupted' })
off();
```

`flightEnd` fires once per flight, after the camera is released: an overview's
pull-back is not an ending. `id` is the `getFlight().id` the flight had, and it
stays the same through an overview's two phases, so a caller that started a
flight can tell its end from another command's. The notification is told once
the command that ended the flight has finished, and an `arrived` once the
camera holds its landing (origin and tracking applied, which the renderer
defers to its next frame), so a listener sees the camera as the flight left it
and may start another flight from the callback. A landing that a later command
took back before it was applied is `stopped`. `interrupted` means the person's own navigation
took the camera — the signal for automation to stop re-asserting a move rather
than retry it. `stopped` is `stopFlight` or any other camera command (a cut, a
reset, a newer flight).

Place refs, imagery layer IDs and activity IDs belong to the scene they were
read from. `getScene().id` changes with every scene bound, a reload of the same
catalog included, so a host holding an ID across a load can tell it is stale
instead of having it resolve against another catalog's records.

The actions that take such an ID (`gotoPlace`, `selectActivity`, `seekActivity`,
`setImageryVisible`, `setImageryOpacity`) also take the scene it was read from,
as `{ scene: getScene().id }` in their options, and throw rather than act when
another scene has been bound since. Two catalogs can reuse a layer and feature
ID, so without it a command issued later than it was read would act on the new
scene's record of that name. Scripts run against the scene they were typed in
and do not pass it; a caller that queues commands (the agent adapter, an
embedding host) does.

Time notifications say who moved the clock (`host`, `viewer` or `playback`) and
coalesce playback to a few a second; see [embedding](embedding.md#control-and-notifications).

A write-only port would make host control half a feature: an app embedding the
viewer could push state at it but never build UI around it, and a palette could
not label a toggle without knowing which way it is set.

Subscriptions outlive a catalog load. They are held by the app rather than by
the renderer, because loading a catalog builds a whole new `UniverseRenderer` —
a host subscribed to the previous one would silently stop hearing from the scene
on screen.

### What "object" means

An **object** is a body the viewer has actually drawn — one that can be tracked,
picked, hidden and labelled. That is narrower than the catalog's item list, and
the gap is not hypothetical: a `Rings` body is rendered as part of its parent and
gets no mesh of its own, so `cassini-soi`'s "Saturn Rings" is a catalog item but
not an object. Every verb that takes an `<object>` resolves against the drawn
set, and `listObjects()` reports that same set — including for "did you mean …?",
where suggesting a name that every verb then refuses would be worse than
suggesting nothing.

## `snapshot()`

`cosmo.snapshot()` returns the script that reproduces the current view.

```
# Cosmolabe snapshot
setPlaying off
setTime 2004-10-26T15:30:00.000Z
setTimeRate 60
gotoObject Titan
setFrame body-fixed Titan
clearLookAt
setFov 35
setCamera [1000, 2000, 3000] [0, 0, 0] [0, 0, 1]
setLayer trajectories on
setLayer labels off
…
```

It captures the whole camera — eye, target, up and FOV — plus what is tracked,
aimed at, selected and displayed. Two things are deliberately **not** in it:

- **A timed `displayNote`.** A caption on a timer is an event in a sequence, not
  state the view is in; reproducing it would either resurrect a caption that has
  already gone or mean modelling how much of its duration is left. A persistent
  note *is* view state and is reproduced.
- **Anything the verbs cannot set.** The snapshot is a script, so its fidelity is
  bounded by the vocabulary — which is the useful bound to have, because it means
  a view that snapshots cleanly is a view a script can rebuild.

Without it every script starts as a blank textarea. With it, you fly somewhere
with the mouse and read back the script that gets there — which is also what a
`cosmolabe://` share URL would carry as its payload.

It is a **serialization surface, not a state model**: it derives its text from
the read side, which reads the app's existing state, and holds nothing of its
own. Two other serializations of a camera exist today — catalog `Viewpoint` JSON
and `camera-view-io.ts` — and this is the intended single one. Unifying them is
not done; recording it here is what keeps a fourth from appearing quietly.

## Mapping to Cosmographia's `Cosmo()`

Cosmographia's scripting is `cosmoscripting.Cosmo()`: a **Python host object**,
not a language. Real scripts look like
`cosmo.displayNote('Jump to August 3, 2014', 2).wait(0)` — chainable methods,
structured vector arguments, durations, and `wait` for sequencing, with loops
and arithmetic coming from Python, which is the *user's* language rather than
Cosmographia's. Our equivalent of Python is JavaScript, which every embed host
already has.

Mirroring `Cosmo()` fixes the *spelling* of what both programs do; it is not a
ceiling. Three rules:

- **Cosmographia has the concept and a workable shape** → take their name.
- **Cosmographia is finer-grained than us** → take their shape. Finer-grained is
  strictly more expressive.
- **We have something they don't** → our name, no apology.

| Cosmographia | Cosmolabe | |
|---|---|---|
| `displayNote(text, seconds)` | `displayNote <text> [seconds]` | Duration optional here: a capture fires at an uncontrolled moment, so a note that always expires cannot be photographed deterministically. |
| `setTimeRate(x)` | `setTimeRate <rate>` | |
| `setTime(...)` | `setTime <when>` | |
| `pause()` / `unpause()` | `setPlaying off\|on` | One verb with an argument, so it is idempotent. A toggle run twice is a no-op. |
| `wait(seconds)` | `wait <seconds>` | Rejected where a frame must be reproducible. |
| `pointAtObject(name)` | `pointAtObject <object>` | |
| `trackObject(name)` | `pointAtObject <object>` | Cosmographia's `trackObject` locks the camera's aim on an object while the camera stays where it is centred. That is our `pointAtObject`. Our `track` is different: it makes the object the orbit's anchor. |
| `gotoObject(name, s)` | `gotoObject <object> [seconds]` | A `jumpTo`, or a direct `flyTo` given seconds. |
| `setCameraToInertialFrame()` | `setFrame free-orbit` | Free orbit is the camera in the inertial scene frame. |
| `showBodyFixedFrame(name)` / `showLatLongGrid(name)` | `setLayer axes on` / `setLayer grid on` | Scene-wide here, per body there ([#153](https://github.com/AaronPlave/cosmolabe/issues/153)). |
| `setFov(deg)` | `setFov <degrees>` | |
| `moveAwayFromCenter(km, s)` | `dolly <km> [seconds]` | Positive moves away, as theirs does; negative moves toward the centre. |
| `craneUp(km, s)` | `crane <km> [seconds]` | Negative cranes down. |
| `circleCenterRight/Left/Up/Down(deg, s)` | `circleCenterRight/Left/Up/Down <degrees> [seconds]` | Same names and arguments. The duration is optional here; without it the move is instant. |
| `moveToPov(name, pos, dir, up, s)` | `setFrame body-fixed <name>` + `setCamera <position> [target] [up]` | Instant, not animated. In a body-fixed frame `setCamera` takes the body's own axes, so the vectors carry over unchanged; `direction` becomes the `target` point. |
| `showTrajectory(name, on)` | `showTrajectory <object> on\|off` | Per-object, their shape. Our global `setLayer trajectories off` stays beside it as the coarse verb. |
| `saveScreenShot()` | `screenshot [label]` | |
| `recordVideo(...)` | `record on\|off` | |
| — | `setLayer <layer> on\|off` | Ours. |
| — | `viewpoint <name>` | Ours: named catalog viewpoints, with epochs. |
| — | `select` / `deselect` | Ours. |
| — | `frameObject`, `flyTo`, `jumpTo`, `stopFlight` | Ours: the navigation vocabulary ([navigation.md](navigation.md)), with an overview flight path. |
| — | `setFrame <mode> [object]` | Ours: eight camera frames including LVLH and chase. |
| — | `clearLookAt` | Ours: the pair for `pointAtObject`, so a snapshot can clear an aim as well as set one. |
| — | `runTo <seconds>` | Ours: the deterministic counterpart to `wait`. |
| — | `snapshot()` | Ours. |

### Not yet in Cosmolabe

Found by adapting Cosmographia's Earth–Moon scripting example (the home
screen's Earth–Moon Scripted Tour). [#153](https://github.com/AaronPlave/cosmolabe/issues/153) tracks them. The tour marks
each one with a "No equivalent yet" comment where it occurs.

| Cosmographia | What is missing | Closest today | Tracked |
|---|---|---|---|
| `gotoHome(s)` | An animated "home" view. | `viewpoint <name>` (instant) | [#153](https://github.com/AaronPlave/cosmolabe/issues/153), [#114](https://github.com/AaronPlave/cosmolabe/issues/114), [#115](https://github.com/AaronPlave/cosmolabe/issues/115) |
| Durations on camera moves | `moveToPov`, `pointAtObject` and the moves above animate over *s* seconds; only `gotoObject`, `flyTo`, `dolly`, `crane` and the `circleCenter*` moves do here. | Instant verbs plus `wait` | [#153](https://github.com/AaronPlave/cosmolabe/issues/153), [#115](https://github.com/AaronPlave/cosmolabe/issues/115) |
| `showBodyFixedFrame(name)`, `showLatLongGrid(name)` | Per-body axes and grid. | `setLayer axes/grid` (scene-wide) | [#153](https://github.com/AaronPlave/cosmolabe/issues/153), [#113](https://github.com/AaronPlave/cosmolabe/issues/113) |
| `showDirectionVector(from, to)` | Direction vectors between bodies. | none | [#153](https://github.com/AaronPlave/cosmolabe/issues/153), [#57](https://github.com/AaronPlave/cosmolabe/issues/57) |
| `hideToolBar`, `hideStatusMessages`, `hideInfoText`, `showFullScreen` (and their inverses) | Scripted control of viewer chrome. The app's zen mode (`\`) also unmounts the console, which stops the script, so this needs its own design. Browsers only enter full screen from a user gesture. | none | [#153](https://github.com/AaronPlave/cosmolabe/issues/153) |

**Running real Cosmographia `.py` is out of scope.** It needs Pyodide or a
translator. This table is what keeps that a mapping problem rather than a
rewrite, if it ever comes up: a `Cosmo` shim over `window.cosmo` would be the
thin part.

## Scripted visual-regression scenes

`scripts/visual-regression.mjs` accepts an optional `script` on a scene, run
after the settle. It composes a view the catalog does not define, which
otherwise has to be pushed into catalog JSON to be reachable at all.

Adding one is a **hand procedure**, not a code change, and the steps are in this
order for reasons the harness's own comments record:

1. `git lfs pull` (the scene's kernels), `bash scripts/check-lfs-pointers.sh`,
   `npx playwright install chromium`.
2. Add the scene with its `script`, and run `node scripts/visual-regression.mjs`
   **without any golden flag**. Two things must happen: every existing scene
   passes unchanged — that is the regression check on whatever you changed, and
   it has to run *before* any golden is written — and the new scene fails with
   `no golden at …`.
3. Read the ink fraction off that failure. Tune the script until it is
   comfortably above the 0.5% diff budget, or the harness's own originality
   check will reject the scene later: a golden that draws less ink than the
   budget cannot fail, whatever happens to the render.
4. `CREATE_VISUAL_GOLDENS=1` once. **Look at the PNG.** Commit it with a message
   naming the epoch and the geometry the script asked for.
5. Run plain twice — once to confirm it matches the golden, once to confirm it
   matches *itself*. A scene that differs from itself between runs is a coin
   flip and does not belong in the set.

`wait` is rejected in a scene script, naming the line.

### Surface graticule

`G` and `setLayer grid on|off` toggle the master grid switch. Free-look retains the
scene-origin body's grid until another body becomes the focus. The default target
is the tracked body. Pinned targets remain pinned when tracking or selection
changes. These operations share Display settings and are included in snapshots;
scripts do not overwrite local display preferences.

```text
setGridScope bodies "Earth,Moon"
setGridDensity auto
setGridLabels on
setGridOpacity 0.7
setGridCoordinateFrame off
setGridMinorLines off
setLayer grid on
showBodyGrid Moon off
showBodyGridLabels Earth off
```

Use `setGridScope tracked` or `setGridScope all` for the other scopes.
`setGridDensity manual 0.1` selects a supported nice angular step between 30°
and 0.001°; arbitrary values are snapped to the nearest supported step. A
per-body `showBodyGrid ... on` enables the master layer; a later
`setLayer grid off` hides every grid while preserving configuration.
Setting a new scope clears per-body overrides.

`setGridOpacity 0.7` fades grid lines and coordinate labels together (0 to 1;
1 retains the authored line style). Display exposes the same value as a percentage.
“Labels at viewport border” (`setGridCoordinateFrame on`) replaces surface captions
with ticks at the viewport border in close overhead views. It does not change the
coordinate system or the surface lines. Zoomed-out views keep surface captions;
at low angles some border ticks are withheld when the surface cannot be certified.

Grid/probe/surface-navigation coordinates use east-positive body-fixed longitude,
with E/W labels and a canonical −180° inclusive to +180° exclusive domain.
Spheres and rotational ellipsoids use geodetic latitude. Triaxial globe reference
surfaces explicitly use planetocentric latitude; geodetic conversion on a
triaxial ellipsoid is unavailable. Mesh-body grids are unavailable.
Lines follow rendered geometry (including terrain and its current LOD); CPU
terrain samples remain authoritative for analytical elevation. This is separate
from the legacy `FixedSpherical` trajectory's declared radial position.
## Places and imagery

A **place** is a point feature of one of the scene's geographic layers (#191):
a Gazetteer name or a mission/user site. It is not an object: `listObjects()`
is the drawn bodies, and a crater is not one of them.

```js
const [jezero] = cosmo.searchPlaces('jezero', { body: 'Mars', limit: 5 });
// { ref, name, body, layer: { id, name }, feature, kind, origin, latitude, longitude,
//   diameterKm?, fields?, source: { kind, identity?, revision? }, unavailable: null | reason }
cosmo.gotoPlace(jezero.ref);                         // fly; { animate: false } cuts; { view: 'oblique' }
cosmo.getPlace(jezero.ref);                          // undefined for a ref this scene does not have
cosmo.getSelectedPlace();
```

Search matches every word of the query against names and aliases by prefix, ranked an exact name first, then by extent. It is bounded (10 by default, at most 100) and skips sources the person excluded from search in the Navigate panel. A place is identified by its `ref` — the layer and feature IDs, or the source's own `placeRef` — never its display name, which need not be unique. `gotoPlace` is false for an unknown ref and throws with the reason when the place exists but cannot be navigated to (its source excluded, or its frame not the rendered surface's); `unavailable` reports the same reason in advance. Place `source` exposes only its category (`kind`); the internal resource identity and revision may contain private locations and are omitted from all three place reads. `layer.id` is catalog-scoped, not a public dataset identifier. In a script, a name where the ref belongs is answered with the refs that name finds:

```text
gotoPlace "Jezero"
# line 1: gotoPlace: no place with ref "Jezero" (matching places: Jezero on Mars = "[\"mars-names\",\"…\"]")
```

A body's **imagery** is its streamed imagery stack (#123), bottom to top:

```js
const mars = cosmo.getImagery('Mars');
// { body, surface: 'static' | 'preloading' | 'waiting' | 'streamed' | 'fallback' | null,
//   imageryOnly, layers: [{ id, name, attribution, description, role, optional, visible,
//   opacity, bounds, resolutionMeters, source, status, view }] }
cosmo.setImageryVisible('Mars', 'hirise', true);
cosmo.setImageryOpacity('Mars', 'hirise', 0.6);
```

The read side reports what is true now, including what is missing: `status` is the request outcome so far (`failed` for a source that could not load); `view`, null while the layer is not drawn, says whether any tile in view is inside its coverage, which zoom the view asks for against the layer's `minZoom`, and how many tiles in view are missing or degraded. A layer that is on can still draw nothing here. `source` reports `{ type, endpoint, layer, tileMatrixSet }`. `endpoint` is only the HTTP(S) provider origin, or null for relative, local and non-HTTP resources. Resource paths, userinfo, queries and fragments are omitted because any of them can hold private tokens. `layer` and `tileMatrixSet` are explicit catalog service identifiers; an origin alone does not identify a dataset. Default display names use the provider host rather than URL path segments. `imageryOnly` means the surface is imagery draped on the ellipsoid with no physical terrain: imagery resolution is not elevation. A body without a streamed surface reports no layers. These settings are transient, like the panel's, and are included in script snapshots by catalog layer ID.

The `ViewerControl` boundary omits raw imagery resource locations and place source identities. It does **not** certify arbitrary catalog text (names, descriptions, attribution or service IDs) as public. External agent adapters (#311) must construct their model context from an explicit allowlist of public metadata, treating catalog text as untrusted input; they must not serialize entire scene/control responses by default. Public provider/dataset identifiers should be deliberately supplied and approved at that boundary, never inferred from a resource path. These reads do not claim dataset-level provenance where the catalog has supplied none.

## Mission activities

`ViewerControl` exposes optional activity capabilities on the native viewer:

```js
const flights = cosmo.listActivities({ vehicle: 'Ingenuity', kind: 'flight' });
const activity = cosmo.getActivity('ingenuity:flight:1'); // undefined for stale/unknown IDs
cosmo.selectActivity(activity.id); // shared selection only; no seek/camera move
cosmo.seekActivity(activity.id, 'start'); // seek only; both edges of an instant use its epoch
cosmo.navigateActivity('next', { vehicle: 'Ingenuity', kind: 'flight' }); // select only
cosmo.getSelectedActivity();
```

Records expose stable ID/name, vehicle/body, kind, the named `site` and `references` (only `references.location` is a link to a place; a `site` alone is a name), actual supplied ET bounds, instant/interval status and provenance (including estimated/bounded timing and limitations). Reads follow the current catalog, and return detached copies. Unknown IDs and exhausted/filter-empty navigation return false; unavailable data never seeks a fallback epoch. Unloading clears records and activity selection. Trajectories can be invisible, absent, analytic or SPICE-backed.

The same operations are available as text verbs, with stable-ID completion and generated console help:

```text
selectActivity ingenuity:flight:1
seekActivity ingenuity:flight:1 end
navigateActivity next Ingenuity flight
```

Order is start/end/ID; within a filter the selected record anchors previous/next. Without a selection in that filter, navigation uses the current clock (next starts strictly after now; previous starts at/before now). It does not wrap. Selection is independent of seeking and camera movement. UI clicks compose pause, selection and seek using these same operations. See [mission activity schema and source limitations](mission-activities.md).

## Agent tools

The verbs are also the write half of the agent tools (`createAgentTools`), which a language-model agent and the Ask Cosmolabe prompt call through the same `execute`. Refusals there are the messages above, word for word. See [agent tools](agent-tools.md).

Local control place provenance/fields can contain private resource paths. Agent tools apply their own conservative metadata projection before model transport; see docs/agent-tools.md.

## Modern analysis automation (#297)

The native viewer now exposes saved measurements/reference geometry, geographic
layers and annotations, place-source inclusion/labels, terrain appearance and
explicit readiness predicates through the same `ViewerControl`. Optional methods
remain the capability declaration: older hosts fail at the relevant script line.
The port has **no runtime import** of core or a renderer. Its TypeScript domain
arguments reference core's types so callers use the existing semantic model,
including `MeasurementDefinition`, `SpatialEndpoint`, `ReferenceVector`,
`GeographicCoordinates`, `GeographicLayerStyle` and `GeographicEditOperation`.

```ts
const scene = cosmo.getScene()!.id;
cosmo.upsertMeasurement({
  id: 'earth-moon', kind: 'distance',
  source: { kind: 'entity', bodyName: 'Earth' },
  target: { kind: 'entity', bodyName: 'Moon' }, vertex: null,
}, { scene });
cosmo.showMeasurement('earth-moon', true, { scene });
cosmo.selectMeasurement('earth-moon', { scene }); // null clears selection
const definitions = cosmo.listMeasurements();  // detached definitions, no sampled results
cosmo.removeMeasurement('earth-moon', { scene });

const layers = cosmo.listGeographicLayers();
const page = cosmo.listGeographicFeatures(layers[0].id, { offset: 0, limit: 50 });
cosmo.selectGeographicFeature(layers[0].id, page.features[0].id, { scene });
cosmo.gotoGeographicFeature(layers[0].id, page.features[0].id, { scene, animate: false });
cosmo.setGeographicLayerStyle(layers[0].id, { version: 1, opacity: 0.7 }, { scene });
```

Every mutation accepting `scene` rejects stale IDs before changing anything.
Scripts bind to the scene at execution start and stop before another statement
can act on a replacement scene. A script replayed in a new run must be used with
the original catalog; IDs alone do not identify a dataset across catalogs.
Measurements use the shared validator before installing any changes (32 saved
definitions, IDs up to 128 characters); references and frames must exist at the
current epoch. Definition installation preserves unrelated definitions and the
creation draft. Visibility/selection do not seek time or move the camera.

Geographic feature IDs are the importer IDs returned by the read API, including
typed prefixes such as `string:airfield-5`; they are not display labels. Each feature read also includes the original typed
`sourceId` for core edit operations; edit receipts return both `featureId` (source
ID) and `ref` (selection ID). Layer discovery includes failed inputs with status/diagnostic codes and unknown
body/frame, rather than hiding them behind the ready-layer list. Features
are paged (default 50, at most 100). Selection uses the UI's shared selection;
focus uses its existing frame-checked extent navigation. Styles are validated,
applied immediately, and do not overwrite saved browser style preferences.

`createAnnotationLayer(body, name, coordinates, { scene })` requires explicit
coordinate conventions compatible with the rendered body frame and returns the
new layer ID. `editAnnotation(layer, operation, { scene })` uses the existing
`GeographicEditSession`, validation, persistence and undo history. It accepts one
bounded core operation, never a second GeoJSON editor; published layers remain
read-only. JSON data supplied through text verbs is limited to 32,768 characters.
Authored edits use normal browser storage, just like the drawing tools.

`selectPlace(ref, { scene })` inspects without navigation; null clears it.
`listPlaceSources()`, `setPlaceSourceEnabled(layer, enabled, { scene })`, and
`showPlaceLabels(layer, visible, { scene })` distinguish search/navigation inclusion
from label visibility. Hiding labels does not exclude the source from search.
`getSurfaceAppearance(body)` returns settings or an explicit unavailable reason;
`setSurfaceAppearance(body, patch, { scene })` validates supported settings and
calls the same terrain appearance action as the UI. Relief styling requires a
validated physical terrain product. It changes no geometry, sampled elevations,
source data, terrain authority or Sun illumination.

The text verbs accept quoted JSON **data**, without eval. Help and completion
come from the verb table; measurement/layer/feature slots complete stable IDs.

```text
upsertMeasurement "{\"id\":\"baseline\",\"kind\":\"distance\",\"source\":{\"kind\":\"entity\",\"bodyName\":\"Earth\"},\"target\":{\"kind\":\"entity\",\"bodyName\":\"Moon\"},\"vertex\":null}"
showMeasurement baseline on
selectMeasurement baseline
setSurfaceAppearance Mars "{\"hillshade\":true,\"contrast\":1.2}"
```

`measurements`, `geographic`, `places` and `surface` subscriptions report shared
UI and control changes, with scene identity and relevant selection/body. They
survive reloads; disposers remove them. These are semantic change notifications,
not per-tile streaming progress. Geographic notifications include style and
layer-data changes. Surface notifications cover visibility/opacity/order and appearance
writes, including UI reordering and elevation-bound picking; use readiness reads/waits for streaming state.

### Readiness guarantees and limits

`getReadiness(request, { scene })` returns a structured observation.
`waitUntilReady(request, { scene, timeoutMs, signal })` waits for that predicate,
with a 15-second default and a hard 120-second maximum. Cancellation, replacement
and disposal terminate the wait and clean up its timer/subscriptions. Reads reuse
the existing asset summaries, imagery view counters and cube base-coverage
counters. A surface observation is invalidated by changes to camera, epoch,
viewport, body transform or imagery settings until an actual streaming update
observes those inputs. They do not start a second streaming manager, prefetch or retry failures.

| Request | A `ready` result guarantees | Excluded or unavailable |
|---|---|---|
| `{kind:'assets'}` | Initial models, textures and trajectories settled without reported failures or asset timeout | Streamed surfaces; source scientific adequacy |
| `{kind:'imagery',body,layer}` | A successful streaming update observed an actually drawn streamed surface; enabled, nontransparent layer intersects the view at minimum zoom with no observed missing/degraded tiles or full cache | Other sources, other views, planetary coverage, source accuracy |
| `{kind:'cube-base',body}` | Mandatory base imagery covers every currently drawn terrain block | Missing geometry, completeness of target LOD, regions outside the view, optional overlays |
| `{kind:'event',reference,et,policy:'timeline'}` | Exact selected scene/query/result/run reference at the requested frozen epoch, in a visible timeline lane, matching a native render pass at the current camera/viewport | No explanatory geometry requirement; no timeline pixels or unoccluded-pixels promise |
| `{kind:'event',reference,et,policy:'native-draw'}` | The timeline predicate plus at least one selected draw-enabled native glyph/span/active explanatory geometry | Hidden/occluded/missing geometry may stay partial; no calibrated geometry or unoccluded-pixels promise |
| `{kind:'terrain',body}` | Successful fresh physical-terrain update; required coverage tiles in the product replacement hierarchy are loaded, geometry is drawn, no pending requests, and drawn geometry meets the configured screen-space LOD target | Only within the product footprint; absent source regions, CPU samples, source accuracy and planet-wide coverage are excluded. Imagery-only surfaces and unavailable frames are `unavailable`; terminal source detail below the LOD target remains `partial` |

Results contain `scene`, `request`, `status`, `missing`, and `limitations`.
Statuses are `ready`, `partial`, `unavailable`, `failed`, `timed-out`, `cancelled`
or `stale`. A fixed timeout never becomes success. Freeze playback and camera
motion when preparing a capture: these predicates observe the current view, they
do not lock it against another user/host. A `waitUntilReady` **text verb** fails the
script unless the result is `ready`, so a later capture never runs on a partial
or timed-out result. Script cancellation is forwarded into the wait.

```text
waitUntilReady "{\"kind\":\"assets\"}" 60
waitUntilReady "{\"kind\":\"cube-base\",\"body\":\"Mars\"}" 60
```

Event capture uses the existing shared wait, not a settling delay. Obtain `reference`
from `getEventResultPage` after a successful run, pause playback, focus the result,
and compose the camera/layers first. Supply its desired epoch and explicitly choose
`timeline` (permits absent glyphs) or `native-draw` (requires explanatory draw state):

```ts
const { reference, event } = c.getEventResultPage(query).items[0];
c.setPlaying(false);
c.focusEventResult(reference, 'start');
c.gotoObject('Saturn'); c.frameObject('Saturn');
const request = { kind: 'event', reference, et: event.et, policy: 'native-draw' };
// quote is the ordinary script-string quoting helper, not interpolation/eval.
await execute(parse(`waitUntilReady ${quote(JSON.stringify(request))} 60\nscreenshot event`), c);
```

`getReadiness(request)` also supports this predicate. A run/query/kernel/context
change or different selected reference is `stale`; changed epoch or active playback
is `stale`; absent native observation support is `unavailable`. A current result
with a hidden timeline lane or absent draw geometry remains `partial`, so its wait
ends `timed-out` unless inputs change. Abort returns `cancelled`; scene replacement
returns `stale`. All non-ready outcomes stop the text program before `screenshot`.
Camera/viewport changes invalidate native observation until another render pass;
these read-only waits never reselect, seek, frame, restart a query or override
manual control. Keep the view frozen through capture. There is no atomic scene lock
against another user/host changing it after the wait completes.

### Portable snapshots and permissions

Snapshots now include portable measurement definitions/selection, catalog place selection, place-source
choices, managed imagery visibility/opacity/order, catalog geographic layer visibility
and styles, supported terrain appearance settings, event-query definitions, session bookmarks, and selected synthetic instrument feed. Measurement snapshots
**merge by ID**: matching definitions are upserted, unrelated user work is kept,
and omitted analysis state preserves it. `restoreMeasurements <json> replace`
is the explicit replacement operation. A supplied selection is restored;
selection omitted from a merge is preserved. No cache arrays or computed results
are serialized. Existing ViewState v1 links and their restore semantics are
unchanged.

User annotation layers, local-file geographic layers, captured terrain-sample
provenance, pointer drafts, timed notes, panel geometry, Event Finder results,
calibrated observation data and instrument pointing results, and surface target anchoring/refinement metadata are not reproduced by script snapshots. A
measurement carrying a captured terrain sample is omitted with a comment because
its original product provenance is not a portable resource contract. Other
surface anchors retain their coordinates/frame/datum. Layer and imagery settings
refer to already loaded catalog IDs; snapshots never package source files or
resource URLs. Do not use a snapshot as an external agent context: arbitrary
catalog/user text has not been certified public.

Capability discovery includes the implemented operations and bounded public reads.
Reversible local definitions/annotation edits are classified `viewer`, require
trusted `allowAuthoring`, and run without repeated confirmation. Deletion, explicit
measurement replacement and whole-state restore require exact-call `confirmAuthoring`. Direct agent
tools also default to refusing authoring unless their host allows it. Export
permission stays separate. Native trusted host/script calls use the typed port;
a catalog script can invoke these bounded data operations but cannot install
plugins or execute arbitrary JavaScript. Agent measurement reads withhold endpoint
and resource provenance; trusted local hosts receive complete definitions.
Operations without verified receipt readback remain explicitly `partial`.

### Event Finder, instruments and session views

`listEventQueries`, `upsertEventQuery`, `removeEventQuery` and `openEventQuery`
operate on the same configured searches as Event Finder. A definition carries
`id`, `label`, `enabled`, `visible` and the core `EventQuery` (`kind`, `bodies`,
`window`, `step`, `abcorr`, optional `params`). Validation uses the existing
registry and view-link validator, including the bounded work budget. Unknown
bodies are refused before mutation. Updating a query invalidates its old results
and selection. Unrelated queries remain intact.

`runEventQuery(id, {scene, signal, timeoutMs})` runs the existing solver and returns
structured `idle/running/complete/failed/cancelled/stale/timed-out` state. The
30-second default and 120-second ceiling bound the wait; workers are cancelled
through the existing worker path. Main-thread synchronous SPICE cannot be
preempted until its call yields. `getEventSearch()` exposes current-call progress
(not an ETA), fault, and exact selected `(query,id)`. `cancelEventQuery` cancels
shared work. `listEventResults(query,{offset,limit,scene})` pages at most 100
results; `selectEventResult(query,id,anchor)` inspects without seeking or seeks
`start/middle/end` through the native selection path. Missing kernels and #329's
unimplemented numerical kinds remain explicit domain failures, never empty
successful searches. `events` notifications include UI edits, results, progress,
selection and search completion; subscriptions survive reloads.

Terminal search outcomes remain observable through `getEventSearch()` after
the call and worker cleanup settle, including cancellation and timeout. They
belong to the query and owning search generation: a superseded run cannot
overwrite a newer outcome. Query edits/removal and catalog replacement clear
the corresponding history; the original in-flight call still reports `stale`
when its scene is replaced. Final status changes emit `events` notifications.

Agent geographic reads project stable IDs, known geometry types, counts and
availability. Free-form layer/feature names, string source IDs, frames and
diagnostic codes require exact `AgentMetadataPolicy.publicValue` approval;
diagnostic and result pages are bounded. Arbitrary imported properties,
annotation payloads, provenance objects and local exception details are never
spread into model output. Trusted local geographic control reads retain their
full data.

For analysis-to-visualization workflows, prefer the run-scoped path:

```ts
const scene = control.getScene()!.id;
control.upsertEventQuery({
  id: 'soi', label: 'Cassini closest approach', enabled: true, visible: true,
  query: { id: 'soi', kind: 'closest-approach',
    bodies: { observer: 'Cassini', target: 'Saturn' },
    window: { start: 141912064.184, end: 141955264.184 },
    step: 60, abcorr: 'LT+S' },
}, { scene });
const info = control.getEventQueryInfo('soi', { scene });
if (info.status !== 'available') throw new Error(info.error?.code ?? info.status);
const run = await control.runEventQuery('soi', { scene, signal, timeoutMs: 120000 });
if (run.status !== 'complete') throw new Error(run.status);
const page = control.getEventResultPage('soi', { scene, limit: 10 });
if (page.status !== 'ready') throw new Error(page.status); // includes no-results
const receipt = control.focusEventResult(page.items[0].reference, 'start', { scene });
// Framing is an independent, explicit camera operation.
control.frameObject('Saturn');
const observation = control.getEventVisualization();
```

`getEventQueryInfo` reads the resolved specification, shared coverage assessment
(including disjoint windows, exact/estimated status and caveats), ET/step units,
correction, analysis context frame and kind-declared calculation frames. Scalar
range is frame independent; the context frame is not a claim that every metric
was evaluated in it. Metric values retain their own native units. The provenance
identifies the live kernel revision/count, not file identities or scientific
accuracy. An unsupported kernel set, missing body or uncovered window remains
unavailable (`missing-coverage` when the shared coverage assessment establishes
it). Reads do not open another query or change the form. Body/query/result IDs
are exact: use existing discovery/`resolve` to disambiguate before authoring;
an ambiguous display label never chooses a plausible body automatically.

`getEventResultPage(query, {order: 'range-ascending'})` ranks all measured
closest-approach candidates in the current completed run before pagination,
returns `ranking.compared`, and refuses ranking if any candidate lacks a measured
range. Chronological first is not necessarily closest. Results apply only to the
actual query window and loaded kernels; search step still limits completeness.

`presentEventResult(reference, 'pair')` pauses, seeks and fits the two event
participants using the existing frame/orbit-target path, then waits up to 1.5 s
for native observation. `'target'` explicitly requests target-only framing. Its
script form is `presentEventResult "<JSON reference>" pair|target`. Manual camera,
time, scene or selection changes interrupt observation without reasserting the
view. Inspect `getEventVisualization().presentation` for the actual tracked
object/reference, projected participant centers and native group visibility;
these observations do not guarantee unoccluded pixels. `focusEventResult`
remains the lower-level inspect/seek operation without framing.

`getEventResultPage` returns at most 100 `{reference,event}` records with an
offset and `nextOffset`. Its status distinguishes `ready`, `no-results`,
`not-searched`, `searching`, `failed`, `stale-result`, `missing-query` and
`scene-reloaded`. A reference contains `{scene,query,id,revision}`: result IDs
are positional within a search, so a rerun invalidates its old references even
when IDs repeat. Query/context/kernel changes also invalidate cached computation.
The existing `listEventResults`/`selectEventResult` convenience operations use
only current results, but their bare IDs do not protect a caller holding an ID
across a rerun; use the reference API for that boundary.

`focusEventResult(reference,anchor)` and the generated
`focusEventResult "<JSON reference>" inspect|start|middle|end` verb invoke the
same selection/seek actions as Event Finder. `inspect` preserves time and camera;
the other anchors seek the event and update the ordinary timeline, primary
object and body highlights. The call is synchronous and never schedules a later
seek or camera motion: finishing a search does not reclaim manual/host time or
camera ownership. Abort, stale/missing results, invalid references, disabled
queries and replaced scenes return explicit refusal states. Existing host effect
permissions and exact authoring confirmations remain authoritative.

Focus returns an `observed` or `partial` receipt. `getEventVisualization` reads
the selected run reference, current epoch/playback, timeline membership/window,
selected object, highlighted bodies, and native renderer observation. Renderer
state separates configured marker groups from draw-enabled glyphs/spans and the
selected active occultation overlay; an epoch without a matching render pass is
unobserved. Hidden/absent trajectories, body occlusion, missing renderers and
unobserved frames stay partial. Counts are not a pixel-visibility or calibrated
geometry guarantee. Existing occultation geometry remains an explanatory
rendered-position construction; GF owns timing and classification.

These reads and the focus verb are discoverable in the `events` capability
domain. Ask receives an allowlisted projection: known query parameters,
bounded numeric metrics/units, coverage windows/status and run references;
private fault text, arbitrary parameters and unapproved frame/provenance strings
are withheld. Capability receipts include event readback and remain partial
until the visualization observation is sufficient. No model/provider call is
required to use or test this workflow.

Compose event selection with existing camera, measurement, annotation and
appearance operations. Snapshots preserve query and supported portable display
definitions, and explicitly report that computed event selection is not replayed.
They serialize no result arrays or run revisions. Rerun and inspect fresh
references before focusing a snapshot's query. Existing ViewState v1 sharing
recomputes searched queries against the receiving kernels and uniquely matches
the selected event by times/state; failure to reproduce it is an error, never a
revived old run reference. Local annotation resources and transient geometry
retain their documented portability limits.

Run `node scripts/test-event-visualization-integration.mjs` against a viewer at
port 5397 (or set `CL_VIEWER_URL`) for the real Cassini GF workflow, ordinary and
`?test=1` viewers, native readback, snapshots/share, no-results, uncovered-window,
stale-reference and cancellation/manual-takeover acceptance. It waits on state
predicates, never a fixed settling delay.

`listInstruments()` lists the renderer's existing sensors. `selectInstrument(name)`
opens that synthetic scene feed, and `null` closes it; the text verb takes an
empty string to close. `getInstrument()` reports FOV (nullable when unknown),
pointing authority, unavailable reason and the last actually observed `observedEt`.
`fresh` requires an observation at the exact current epoch and no render error;
`renderError` reports a failed frame separately from physical pointing. A clock
tick between frames preserves the previous pointing and epoch rather than
inventing a pointing failure. Strict consumers must require `fresh` and their
requested epoch; playback UI can continue showing the last frame. Event and probe
readbacks likewise retain the preceding epoch between clock ticks, while strict
event readiness still requires the requested epoch and camera/viewport. This is a
`synthetic-scene-view`, never calibrated observation data. The UI and hosts use
the same selection and `instruments` notifications. Actual observation ingest and
calibration remain owned by #28/#192–#195.

`saveBookmark`, `upsertBookmark`, `removeBookmark` and `listBookmarks` use the
existing camera viewpoint store. `viewpoint <name>` applies one. Catalog and
`Default` names are protected; other names merge individually, preserving
unrelated session views. Bookmark definitions hold a camera pose, origin,
tracking/look-at and optional epoch; they contain no imagery caches or source
locations. `bookmarks` notifications cover UI and host edits. Snapshot replay
preserves an off-centre orbit target through subsequent rendering using the
camera controller's existing scene-axis offset, without reconstructing a terrain
anchor or transforming imported source coordinates.

`await getViewState()` captures the existing ViewState v1 format and validated
optional analysis envelopes. It refuses local/opaque catalog resources which
have no portable catalog location. `restoreViewState(state,{scene,signal})` is a
same-catalog operation: all envelopes and body references validate before camera
changes. Supplied analysis envelopes replace their domains, absent envelopes
preserve them; explicit empty envelopes clear them. Existing permalink restore
keeps its original replacement semantics. Snapshots instead merge definitions by
stable ID. Neither serializes computed event results; view links rerun explicitly
marked searches through the existing solver. Cancel/reload/disposal prevents the
restore's final camera action from affecting another scene.

The new text verbs generate help and completion from `VERBS`; query/result and
instrument completion uses stable runtime identities. Typed hosts get full
scientific definitions. Agent discovery offers bounded allowlisted summaries
without endpoint/resource metadata or solver fault text; raw ViewState capture
is trusted-host-only. Query/bookmark definitions and annotation edits retain host authoring permission;
ordinary reversible edits need no repeated confirmation. Deletion, explicit
measurement replacement and whole-state restore retain exact-call confirmation.
Capture/export keeps its separate trusted host policy. Registered consumers are
the existing capability adapter, embedding hosts, ScriptConsole and catalog
tours; no plugin installation, catalog JavaScript, generic extension registry,
chat/MCP/voice transport or new solver is introduced.

### Mission tour and capture fixture

The ordinary index entry **Ingenuity Analysis Tour** links
[`ingenuity-analysis-tour.cosmo`](../apps/viewer/test-catalogs/ingenuity-analysis-tour.cosmo)
to the existing Ingenuity/Jezero catalog. It composes Flight 5 selection/seek, a
stable named place, coordinate navigation, imagery and geographic styles, a saved
Mars-centre distance definition and physical-terrain appearance. The caption
retains the trajectory's estimated timing/path limitation and does not describe
centre distance as terrain clearance. Missing products fail transparently.

Run `CL_VIEWER_URL=http://127.0.0.1:5297/ node scripts/test-modern-scene-automation.mjs`
against a viewer from this checkout. The fixture exercises the ordinary scripted
entry and `?test=1` script execution, asserts semantic state and readiness,
round-trips the supported snapshot, tests missing-source refusal, and writes
screenshots plus a compact JSON report under `/tmp/modern-scene-automation`.
It uses no arbitrary settle delay. The report records GPU identity and the
predicate limitations; a passed cube-base check is not terrain coverage acceptance.

### Ask access and approvals

Ordinary Ask offers a compact direct read shortlist and an index of every
registered script operation through the shared capability registry. Detailed
schemas hydrate and validate automatically; list/describe calls are optional.
Routine Event Finder configuration and reversible local edits run under the host
permissions already granted. Destructive deletion/replacement, whole-state restore,
and export/recording require exact-call approval in the Ask panel; a conversational “yes” or
catalog text cannot grant permission. Embedded hosts supply their own policy.
Stopping, replacing or closing the request rejects a pending UI approval.

Event searches can begin with the read-only `getEventSearchOptions` host/capability
operation to discover built-in kinds, roles, defaults and assessed loaded-kernel
coverage. A suggested window is a catalog/coverage overlap, not a claim of complete
mission coverage. Ask's event pages default to one result (maximum five); follow
`nextOffset`. Creating a query uses the saved-definition model and approval; the
query remains in session snapshots. Computation, focus and readiness reuse the
same Event Finder and native observation paths as scripts and UI.

See the [current validation guide](validation/297-scene-automation.md) and run
`node scripts/check-ask-capability-coverage.mjs` after building to verify Ask
registration, routing and permission invariants. Raw snapshot/resource
transport exclusions remain explicit; these do not authorize arbitrary local
file, clipboard or network access.
