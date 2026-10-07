# Navigation: Select, Track, Frame, Fly, Jump

Cosmolabe has one vocabulary for "go to this thing", and every surface that
navigates — the body browser, the command palette, the scene's context menu and
double-click, the info panel, event results, the keymap, scripts and the
embedding API — calls it rather than deciding for itself what "go to" means.

There are five operations. They are separate on purpose: none implies another.
Selecting never moves the camera, and moving the camera never selects. A surface
that wants two of them calls both.

| Operation | Changes | Camera moves? | Script verb | `ViewerControl` | Viewer function |
|---|---|---|---|---|---|
| **Select** | the analytical selection | never | `select <object>` | `select(name)` | `selectBody` |
| **Track** (focus) | the camera's anchor | no — it turns to face the object | `track <object>` | `track(name)` | `trackBody` |
| **Frame** | anchor and distance | cut | `frameObject [object]` | `frameObject(name?)` | `frameBody` |
| **Fly** | anchor and pose | animated | `flyTo <object> [path] [seconds]` | `flyTo(name, { path, seconds })` | `flyToBody` |
| **Jump** | anchor and pose | cut | `jumpTo <object>` | `jumpTo(name)` | `jumpToBody` |

The viewer functions live together in
[`apps/viewer/src/lib/viewer-state.svelte.ts`](../apps/viewer/src/lib/viewer-state.svelte.ts)
under "Navigation verbs". The camera-side primitives they call are
`CameraController.focus`, `frame`, `flyTo` and `stopFlight` in
[`packages/three`](../packages/three/src/controls/CameraController.ts).

## The operations

### Select

Changes what the info panel, the timeline and the other analytical views are
about. The camera does not move, and nothing about tracking changes. Selecting
an event result selects its primary body this way: the event's time and bodies
come into view through the time seek and the highlight, not through the camera.

### Track (focus)

Makes an object the camera's anchor: the body it orbits and follows, and the
origin the scene is drawn around. The camera **stays where it is** and turns to
face the object; it is not moved closer. If the object is far away it is small
on screen — Frame is the next step when that is not what you want.

In a camera frame other than free orbit (body-fixed, spacecraft-fixed, …) the
frame is re-parameterized onto the newly tracked object, as switching frames
would.

`untrack` releases the anchor; the camera again stays where it is.

### Frame

Cuts to a view that fits the object, and tracks it. The camera keeps the side
it sees the object from and moves along that line until the object's bounding
sphere, padded by half, fits the narrower of the two fields of view. At a 60°
vertical field of view in a landscape viewport that is three radii from its
centre; a portrait viewport stands further back so the object still fits
across. With no object given, Frame re-fits whatever is tracked.

### Fly

Animates to the pose Frame would cut to, then tracks the object. The endpoints
follow the object while it moves, and the scene origin switches to it when the
camera lands. Two paths:

- **Direct** closes on the destination in a straight line. One second by
  default.
- **Overview** first pulls back far enough that the point the camera is looking
  at and the destination are both in view — looking at the midpoint between
  them, from the side, so neither hides behind the other — then approaches the
  destination from there. Two and a half seconds by default, 40% of it pulling
  back. Across an astronomical change of scale a direct flight shows nothing but
  a blur; the pull-back is what says where the destination is. When the camera
  is already that far back there is nothing to establish, and an overview flight
  is a direct one.

The viewer's surfaces and `flyTo` without a path use **overview**.
`gotoObject <object> <seconds>`, which predates the choice, keeps flying
**direct**.

A flight returns at once. A script that needs it to land follows it with
`wait`; a host can poll `getFlight()`.

### Jump

Applies the view a flight would land on, immediately. For an object that is the
pose Frame cuts to; the two differ in what they are for (a destination, rather
than re-fitting what is already in view), not in where the camera lands.

A jump in time is a separate operation (`setTime`). A command can do both — a
catalog viewpoint with an epoch does — but the two stay separate underneath.

`gotoObject <object>`, Cosmographia's name, is a Jump.

## Who owns the camera during a flight

A flight owns the camera until it lands. **Manual navigation stops it where it
is**: a drag past a few pixels, a wheel zoom, a pinch, or a held movement key
(W/A/S/D/Z/C/Q/E). The camera keeps its pose, the object the flight was heading
for becomes the tracked object, and the input that stopped the flight applies
in the same frame. The same holds for a scripted `dolly`, `crane` or
`circleCenter*` move that is still playing: input stops it rather than the two
taking turns with the camera.

A click without a drag does not stop a flight, so selecting something while
the camera flies does not cancel it. Shift+wheel changes the field of view,
which no flight touches, and does not stop one either.

`stopFlight` (script and `ViewerControl`), <kbd>Esc</kbd>, the × in the view
context, and the "Stop camera flight" palette command stop a flight the same
way.

## What the viewer shows

The view context at the top of the viewport carries the navigation state that
is otherwise not obvious:

- **Flying to _object_**, with a × to stop, while a flight owns the camera;
- **Tracking _object_**, and the look-at target if there is one;
- **Frame**, the camera frame, when it is not free orbit.

It is hidden when the camera is in free orbit, tracking nothing and not flying.

## Surfaces

| Surface | Calls |
|---|---|
| Body browser — click a row | Select + Fly |
| Command palette — a body | Select + Fly |
| Scene — double-click a body | Select + Fly |
| Scene — right-click a body | Select, Track, Frame, Fly, or Look at |
| Info panel — Fly to button | Fly to the selected body |
| Selected event — "Fly to …" | Fly to the event's primary body (selecting the event already selected it) |
| Display settings — Fly to button, <kbd>F</kbd>, "Fly to tracked body" | Fly to the tracked body |
| Command palette — "Frame tracked body" | Frame |
| <kbd>Esc</kbd>, view context ×, "Stop camera flight" | Stop the flight |
| Display settings — viewpoint list | Fly to the viewpoint (one that tracks a body is placed at once; `viewpoint` in a script always jumps) |
| Scripts and `ViewerControl` | All of the above by name |

## Related mechanisms

- **Camera frames** (`setFrame`: free orbit, body-fixed, LVLH, …) are how the
  camera moves with what it tracks. They are lower-level than these verbs and
  not replaced by them. `setFrame <mode> <object>` frames the object before it
  switches, so the new frame starts from a view of it.
- **Look at** (`pointAtObject`) aims the camera at a second object while it
  orbits the tracked one. Track, Frame, Fly and Jump clear it.
- **Viewpoints** are declarative camera poses, optionally with an epoch.
  Applying one is a jump (with a time seek when it has an epoch); the display
  settings list flies to it.

## Not in scope

A generalized camera-path planner, a cinematic path editor, a plugin API for
custom camera modes, and selection that moves the camera.
