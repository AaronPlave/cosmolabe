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

What happens to a camera frame other than free orbit is under
[Camera frames](#camera-frames).

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
  default. This is the default: routine navigation should be quick.
- **Overview** first pulls back far enough that the point the camera is looking
  at and the destination are both in view — looking at the midpoint between
  them, from the side, so neither hides behind the other — then approaches the
  destination from there. Two and a half seconds by default, 40% of it pulling
  back. Across an astronomical change of scale a direct flight shows nothing but
  a blur; the pull-back is what says where the destination is. When the camera
  is already that far back there is nothing to establish, and an overview flight
  is a direct one.

Every surface that flies, and `flyTo` without a path, flies **direct**.
Overview is a deliberate choice for seeing how two places relate, never
something a click does unasked: the context menu's "Fly via overview", the
palette's "Fly to tracked body via overview", and `flyTo <object> overview`.
Nothing switches to it by distance. `gotoObject <object> <seconds>` flies
direct too.

A flight returns at once. A script that needs it to land follows it with
`wait`; a host can poll `getFlight()`.

### Jump

Applies the view a flight would land on, immediately. For an object that is the
pose Frame cuts to; the two differ in what they are for (a destination, rather
than re-fitting what is already in view), not in where the camera lands.

A jump in time is a separate operation (`setTime`). A command can do both — a
catalog viewpoint with an epoch does — but the two stay separate underneath.

`gotoObject <object>`, Cosmographia's name, is a Jump.

## Camera frames

The verbs work in the frames where the person sets the pose — free orbit,
body-fixed and spacecraft-fixed. The other frames place the camera themselves —
LVLH, chase, surface, surface explorer and instrument — and a verb that would
fight one for the camera leaves it for free orbit instead, explicitly, rather
than reactivating it and losing its state (follow distance, latitude and
longitude, sensor).

| Frame | Track | Frame, Fly, Jump |
|---|---|---|
| Free orbit | — | — |
| Body-fixed, spacecraft-fixed | Moves onto the object (body-fixed: the body it orbits, for a spacecraft), as switching frames would; left as it is when already there | The same, on landing — or when a flight is stopped |
| LVLH, chase, surface, surface explorer | Left as it is, state and view and all, when set on the object itself; otherwise — including a spacecraft orbiting the body a surface frame is on — free orbit, the camera where it is | Free orbit, as the cut or flight starts |
| Instrument | Left as it is: the view is the sensor's, not the object's | Free orbit, as the cut or flight starts |

To put one of those frames on a new object, switch to it: `setFrame <mode>
<object>`.

## Who owns the camera during a flight

A flight owns the camera until it lands. **Manual navigation stops it where it
is**: a drag past a few pixels, a wheel zoom, a pinch, or a held movement key
(W/A/S/D/Z/C/Q/E). The object the flight was heading for becomes the tracked
object, as though Tracked from where the camera stopped: the camera keeps its
position and turns to face the object — a turn, during an overview's pull-back,
from the midpoint it was looking at. The input that stopped the flight then
applies in the same frame, to the camera orbiting that object. The same holds for a scripted `dolly`, `crane` or
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
| Scene — right-click a body | Select, Track, Frame, Fly, Fly via overview, or Look at |
| Info panel — Fly to button | Fly to the selected body |
| Selected event — "Fly to …" | Fly to the event's primary body (selecting the event already selected it) |
| Display settings — Fly to button, <kbd>F</kbd>, "Fly to tracked body" | Fly to the tracked body |
| Command palette — "Fly to tracked body via overview" | Fly to the tracked body, overview path |
| Command palette — "Frame tracked body" | Frame |
| <kbd>Esc</kbd>, view context ×, "Stop camera flight" | Stop the flight |
| Display settings — viewpoint list | Fly to the viewpoint (one that tracks a body is placed at once; `viewpoint` in a script always jumps) |
| Command palette — "Go to coordinates…" | Fly or Jump to a latitude/longitude on a body ([surface navigation](#surface-navigation)) |
| Scene — right-click a surface | Zoom to here, Fly to here (beside the body's own actions) |
| Point probe panel — Fly to here, Frame here; palette "Fly to probed point" | Fly or Jump to the pinned point |
| Scripts and `ViewerControl` | All of the above by name |

## Surface navigation

Fly and Jump also take a **place on a body** rather than the body as a whole
(#190). The place is the target — what the camera looks at and then orbits —
never the camera's own position. Three surfaces name one:

- **Go to coordinates…** (command palette; `gotoCoordinates` in a script and
  on `ViewerControl`): a body, a latitude and a longitude. The conventions are
  explicit and on screen: planetocentric or planetographic latitude,
  east- or west-positive longitude, either −180…180 or 0…360 (N/S and E/W
  letters are absolute directions). Then a view:
  - **Overhead** — straight down the surface normal, north up;
  - **Oblique** — 50° off vertical, from the south;
  - **Surface** — at a person's eye height (2 m; less on a body a few km
    across) just south of the place, looking north at it.

  Distances scale with the body; *Advanced* overrides the altitude, slant
  range or eye height.
- **Right-click a surface** in the scene: **Zoom to here** cuts, and **Fly to
  here** flies, along the line of sight the point was clicked on, a quarter
  of the way out from it. That line is clear by construction, so neither
  goes round the globe, and neither changes the camera frame. The menu offers
  them only when the shared scene hit (#127) found a surface; a click into
  space or on a spacecraft gets the ordinary menu. A right-drag is still
  free look and opens no menu. A DSK shape model's surface is not offered
  yet: its picks are in the model's own frame, which surface navigation does
  not handle (#107).
- **The pinned Point Probe**: *Fly to here* / *Frame here* go to the same
  surface point, without re-entering it — along the line of sight while the
  point faces the camera, otherwise overhead.

Where it lands:

- Coordinates resolve through `@cosmolabe/core`'s geographic navigation
  against the body's declared physical shape: its terrain datum when it
  streams terrain, otherwise its catalog radii — never the renderer's display
  radius. A body with neither, an irregular (DSK) body, or one without a
  rotation model is refused with the reason; so is planetographic latitude on
  a triaxial body. Out-of-range input is refused, never clamped.
- On a terrain body the place is raised onto the decoded terrain sample;
  where the terrain has not loaded yet the place goes on the reference
  surface for now, says so, and moves onto the terrain — pivot and camera
  together, keeping the framing — as soon as a sample decodes there. A placement's eye is lifted clear of terrain known under
  it, and the renderer's terrain clamp still applies.
- A picked point is used exactly as picked, with its own source and datum.
- The placement is a semantic viewpoint (#114): `center` the body, `frame`
  `BodyFixed`, eye, target and up body-fixed. It re-resolves as the body
  turns, so the place stays put as time runs.

How it moves:

- A flight to coordinates swings round the body on an arc that rises with
  how far round it goes (half a radius up for the far side) and never drops
  inside the smaller of its two end distances, so it cannot cut through the
  globe. Its path is in the body's frame, so the landing tracks the ground as
  the body turns.
- On landing (or a cut) the body is tracked and **the place is the orbit
  pivot**: wheel zoom closes on it and drag orbits about it, instead of
  snapping back to the body's centre. In free orbit the camera turns with
  the body so the place stays where it is on screen. On a globe without
  terrain the camera may come within 2 m of the ground about the pivot. Any other navigation
  ends the pivot; so does a right-drag or a movement key, as they end
  tracking.
- Manual input stops the flight where it is, facing the place — as for any
  flight.
- Time, the selection and measurements do not change. The view context shows
  **Target** with the place's coordinates (its tooltip: conventions and what
  surface it is on).

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
