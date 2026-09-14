# The 3D-first shell

The viewer's scene is the continuous base layer. Everything else — the rail,
the contextual panels, the timeline — floats over it. Nothing partitions the
viewport into dashboard regions, and nothing positions itself.

That last part is the rule this shell exists to enforce. Before it, panels each
carried their own `absolute top-3 left-3 …`, and the event finder, the measure
tool and the diagnostics panel all claimed the same slot: opening two drew one
on top of the other. A panel now says what it is; the shell decides where it
goes — and the user overrules the shell.

Two properties follow from "the arrangement is a default, not an address":

- **Panels are manipulable.** Drag a panel's header and it leaves the dock,
  floating where it was picked up, movable and resizable from there. The dock
  button sends it back.
- **Minimized is not closed.** An instrument you want out of the way keeps its
  search, its selection and its form; only its body is hidden. Closing is the
  separate, destructive act, and it should not be the only way to see the scene.
- **Attention has an order.** `shell.panelOrder` records which panel was touched
  most recently. One list answers two questions: which floating panel draws on
  top, and which surface Escape dismisses.

The shell lives in `apps/viewer/src/lib/shell.svelte.ts` (state) and
`apps/viewer/src/components/shell/` (the primitives).

## The pieces

| Piece | Responsibility |
| --- | --- |
| `TOOLS` | The tool table: id, label, icon, presentation, dock, width, shortcut. The rail, the keyboard map and anything else that enumerates tools read this one list. |
| `shell.openTools` | Open surfaces, least-recently-opened first. It is both the dock's stacking order and what Escape closes. |
| `shell.panels` | Per-panel placement: `{ minimized, float }`, keyed by `PanelKey`. Seeded for every panel, so none has to create its entry while rendering. |
| `shell.layout` | `desktop` or `compact`. One `matchMedia` listener, bound by `watchLayout()`. |
| `shell.activeSheet` | The one panel showing when compact. |
| `shell.panelOrder` | Focus order, least-recently-touched last-but-one. Drives floating `z-index` and Escape. |
| `shell.mounted` | Which panels are rendered. Panels register themselves, so the shell need not model why each one is up. |
| `panel-geometry.ts` | `clampFloat` / `moveFloat` / `resizeFloat` — the constraints on a floating rect, as plain functions so they can be tested without a browser. |
| `ToolRail` | The persistent rail. Icon width, never more. Opens surfaces; never contains them. |
| `InstrumentPanel` | The one panel primitive: quiet chrome, a caption, an optional `actions` snippet, and the minimize / float / dock / close controls. Owns the drag and resize gestures. |
| `PanelDock` | Lays open panels out down one side, or into one bottom sheet when compact. |
| `ToolPanels` | Maps the open `panel` tools to their components, in open order. |
| `TimelineDock` | Transport, time axis and playhead, plus the expandable region that event lanes and geometry profiles share. |

## Adding an analysis surface

Add a row to `TOOLS`, and a branch to `ToolPanels`. The component wraps its own
content in `InstrumentPanel` and positions nothing:

```svelte
<InstrumentPanel key="occultations" title="Occultations" width={toolDef('occultations').width} {onClose}>
  …
</InstrumentPanel>
```

The `key` is what makes a panel manipulable: without one it is a plain box,
because there is nowhere to keep its minimized flag or its float rect. `info`
and `pick` are keys without being tools — the body info panel follows the
selection and the pick readout follows a click, so neither belongs on the rail,
but both should move and minimize like anything else.

That is the whole integration. The rail button, the keyboard shortcut, the dock
placement, the stacking order, the Escape behaviour and the compact bottom-sheet
presentation all follow from the table row.

## Presentations

All current tools are `panel`s. This keeps the header, movement, minimization,
dock layout and compact-sheet behavior consistent, and prevents a legacy
full-screen backdrop from blocking another open tool. The presentation type
still leaves room for a genuinely transient drawer or menu in the future.

## Floating

Dragging a panel's header past a few pixels of slack converts it to floating at
the rect it already occupies, so the gesture reads as picking the panel up
rather than as it jumping somewhere and then moving. Floating panels use
`position: fixed`, which escapes the dock's scroll clipping with no portal.

Pressing anywhere on a floating panel raises it: `panelZIndex` is just its place
in `panelOrder`, offset from `FLOAT_Z_BASE` and bounded below the drawer and menu
layers, because a floating instrument is part of the workspace and should not
cover the catalog.

That is the entire mechanism. There is no tiling, no snapping and no
persistence — a rectangle, one ordered list, and two constraints:

- A panel cannot be resized below `MIN_PANEL_W` × `MIN_PANEL_H`.
- A grabbable strip always stays on screen (`KEEP_VISIBLE_X` / `_Y`), and the
  header never goes above the top edge. A panel dragged into a corner is always
  recoverable by dragging, which is why there is no "reset layout" command.

`reclampFloats` re-applies those when the window resizes, so a shrinking viewport
cannot strand a panel where nothing can reach it. It judges by the viewport it is
handed rather than by `shell.layout`: `resize` and the `matchMedia` listener fire
in no guaranteed order, so on the way down to a phone width it runs at least once
while the layout still says `desktop`.

Float rects outlive both closing a panel and a trip through the compact layout.
Where you put an instrument is a preference, and a window narrowed and widened
again should hand back the workspace you arranged, not a pile of panels in their
docks. Compact ignores the rects while it is active; it has nowhere to float
anything.

## Escape

Escape dismisses the topmost *visible* panel — `topVisiblePanel()`, the most
recently touched panel that is mounted and not minimized. Compact minimizes it;
desktop closes it. Then it falls through to pick mode, the selection, and a
camera reset, as it always did.

Two earlier versions got this wrong the same way, by going from list order rather
than from what was on screen: the first walked an if/else chain in source order,
so Escape closed whichever panel happened to be written first; the second took
the end of `openTools`, which ignores the selection-driven panels entirely and,
on a phone, could close a tool hidden behind the sheet being read.

## Measurements

Two CSS variables, published by `App.svelte` onto the shell root:

- `--size-rail` — the rail's width, or `0` when it is horizontal, so left-docked
  surfaces need no compact branch of their own.
- `--size-dock-base` — bottom of the viewport to the top of whatever docks above
  the bottom chrome.

`--size-dock-base` comes from `bind:clientHeight` on that chrome rather than from
a constant. Its height is not the shell's to choose: it grows with the expanded
lane region, with the shortcut strip, and at a phone width with a transport that
wraps. The first version used rem constants, and the wrapped transport promptly
grew underneath the rail and swallowed its clicks.

## Compact

The compact layout is a different presentation of the same state, never a second
feature model. No component has a mobile twin; `shell.layout` is the only thing
that branches.

Two rules shape it, both in service of keeping the scene primary:

- **One sheet at a time.** `shell.activeSheet` names it. Other open tools stay
  open with their state intact, and the rail switches between them — pressing
  the visible one puts it away, pressing any other brings it forward. The
  version this replaced scrolled every open panel into one tall sheet and left
  the scene a strip at the top.
- **One bar of chrome.** The rail and the transport share a single bottom dock,
  and the transport keeps to one row — play, axis, clock — with the rate and
  step controls behind the same expand toggle the lane region uses. Two stacked
  bars with a three-row wrapped transport cost the scene about a third of a
  phone screen before a sheet was even open.

The compact rail scrolls horizontally rather than squeezing. It fits today and
will not once #58's event kinds and #57's measurement tools arrive, and a row
that silently drops its last button is a worse failure than one that scrolls.
The buttons sit in an inner row with `margin: auto` rather than the scroller
using `justify-center`, which would clip the overflow at the *start* and put the
first tools permanently out of reach.

The rail marks a stowed tool differently from both a closed one and the one on
screen. That distinction is the point of minimizing: it is what tells the user
their search is still there.

## Visual grammar

The shell uses two type families with distinct jobs. Martian Mono is reserved
for scientific values: time, coordinates, distances, angles, identifiers and
telemetry. Public Sans belongs to panel titles, navigation, controls, labels,
body names and explanatory text. Both are bundled with the viewer; the
workspace does not depend on a web-font request.
Within panels, interface copy and controls share an explicit 11px baseline,
supporting metadata steps down to an explicit 10px minimum, and only analytical
values step up from that base. These are pixel tokens because the viewer uses a
13px root; rem-derived type here would otherwise fall below the minimum.

Desktop chrome is structurally attached to the viewport: a narrow rail at the
left and a timeline at the bottom, separated from the scene by one crisp line.
Panels remain movable surfaces above that frame. Their near-black material,
small radius and sparse shadow keep them related to the frame without reading
as generic dashboard cards. Only floating panels receive a shadow.

Canvas, panel, control, hover, selected, border, text, primary-accent and
event-accent colors are named semantic tokens in `app.css`. Blue is used for
active, selected, focused or primary state; restrained amber identifies event
information. Routine structure relies on surface contrast and spacing before
outlines.

Chrome feedback is shared: the same focus ring, quick transition timing and
pressed movement are used by panel, rail and timeline controls. Active and
stowed shell state is monochrome; blue is reserved for keyboard focus and
genuinely analytical or mission emphasis. Borders and surface area stay neutral
so the data retains the strongest visual emphasis. Nonessential chrome motion
collapses to effectively zero when the system requests reduced motion.

The expanded timeline uses a faint plotting grid instead of a card-like empty
state. Its transport remains secondary, while the white playhead is the highest
contrast element on the shared time axis.

At compact widths, controls retain touch-sized targets while the rail and
transport share one bottom surface. Secondary rate controls and the zoom menu
leave the transport row, and the clock uses time-only notation. An active sheet
is capped at 42 percent of the viewport and scrolls internally, preserving the
3D scene as the largest single region.

## What this is not

The arrangement is a useful default, not information architecture. Panel
positions, widths, chrome and the compact presentation are all meant to be
retuned from real scenes and workflows. Nothing here is a contract except that
panels do not position themselves.
