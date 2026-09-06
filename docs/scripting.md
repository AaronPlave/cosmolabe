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

Everything lives in [`@cosmolabe/control`](../packages/control), a zero-dependency
package with no DOM and no renderer in it. The viewer's implementation is one
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
| `gotoObject <object> [seconds]` | Track an object and frame it. **Cuts by default**; give seconds to fly there. |
| `select <object>` | Select an object — what the info panel shows. |
| `deselect` | Clear the selection. |

`gotoObject` does not animate unless asked, because a fly-to is a one-second
animation that only installs the new origin body on completion: a caller that
renders one frame and photographs it gets the camera mid-flight.

### Camera

| Verb | |
|---|---|
| `track <object>` | Orbit-lock to an object without moving the camera. |
| `untrack` | Release it. The camera stays where it is. |
| `pointAtObject <object>` | Aim at an object while still orbiting what is tracked. Idempotent — it does not toggle. |
| `clearLookAt` | Stop aiming at an object. |
| `viewpoint <name>` | Apply a named catalog viewpoint, seeking the clock if it declares an epoch. |
| `setFrame <mode> [object]` | Switch camera frame, optionally onto an object. |
| `setCamera <position> [target] [up]` | Place the camera: eye, the point it looks at, and up — all in km. |
| `setFov <degrees>` | Vertical field of view. |

`setCamera` takes eye, target and up in that order — the same order catalog
`Viewpoint` JSON and `camera-view-io.ts` already use. `target` is not optional
decoration: position and up alone say where the camera stands and nothing about
what it sees.

`setCamera` sets a **pose and nothing else**. It does not clear what is tracked
or what is being pointed at, and both keep acting on the camera afterwards:
while an object is tracked the pose is relative to it, and while `pointAtObject`
is in effect the aim follows that object and overrides `target` on the next
frame. Call `untrack` / `clearLookAt` first if the pose should stand alone.

`<mode>` is one of `free-orbit`, `sc-fixed`, `body-fixed`, `lvlh`, `chase`,
`surface`, `surface-explorer`, `instrument`.

`setFrame` tracks the named object **before** switching mode. Asking for
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

## The read side

```ts
cosmo.getTime();          // seconds past J2000
cosmo.getRate();
cosmo.isPlaying();
cosmo.getSelected();      // string | null
cosmo.getTracked();
cosmo.getCamera();        // { position (km), up, fov }
cosmo.listObjects();
cosmo.listViewpoints();
cosmo.getCamera();        // { position, target, up, fov } — all in km

const off = cosmo.on('select', ({ name }) => …);   // also 'time' and 'load'
off();
```

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
| `trackObject(name)` | `track <object>` | |
| `gotoObject(name)` | `gotoObject <object> [seconds]` | |
| `setFov(deg)` | `setFov <degrees>` | |
| `moveToPov(name, pos, …)` | `setCamera <position> [up]` | |
| `showTrajectory(name, on)` | `showTrajectory <object> on\|off` | Per-object, their shape. Our global `setLayer trajectories off` stays beside it as the coarse verb. |
| `saveScreenShot()` | `screenshot [label]` | |
| `recordVideo(...)` | `record on\|off` | |
| — | `setLayer <layer> on\|off` | Ours. |
| — | `viewpoint <name>` | Ours: named catalog viewpoints, with epochs. |
| — | `select` / `deselect` | Ours. |
| — | `setFrame <mode> [object]` | Ours: eight camera frames including LVLH and chase. |
| — | `clearLookAt` | Ours: the pair for `pointAtObject`, so a snapshot can clear an aim as well as set one. |
| — | `runTo <seconds>` | Ours: the deterministic counterpart to `wait`. |
| — | `snapshot()` | Ours. |

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
