# The 3D-first shell

The viewer's scene is the continuous base layer. Everything else — the rail,
the contextual panels, the timeline — floats over it. Nothing partitions the
viewport into dashboard regions, and nothing positions itself.

That last part is the rule this shell exists to enforce. Before it, panels each
carried their own `absolute top-3 left-3 …`, and the event finder, the measure
tool and the diagnostics panel all claimed the same slot: opening two drew one
on top of the other. A panel now says what it is; the dock decides where it
goes.

The shell lives in `apps/viewer/src/lib/shell.svelte.ts` (state) and
`apps/viewer/src/components/shell/` (the primitives).

## The pieces

| Piece | Responsibility |
| --- | --- |
| `TOOLS` | The tool table: id, label, icon, presentation, dock, width, shortcut. The rail, the keyboard map and anything else that enumerates tools read this one list. |
| `shell.openTools` | Open surfaces, least-recently-opened first. It is both the dock's stacking order and what Escape closes. |
| `shell.layout` | `desktop` or `compact`. One `matchMedia` listener, bound by `watchLayout()`. |
| `ToolRail` | The persistent rail. Icon width, never more. Opens surfaces; never contains them. |
| `InstrumentPanel` | The one panel primitive: quiet chrome, a caption, an optional `actions` snippet, a close button. |
| `PanelDock` | Lays open panels out down one side, or into one bottom sheet when compact. |
| `ToolPanels` | Maps the open `panel` tools to their components, in open order. |
| `TimelineDock` | Transport, time axis and playhead, plus the expandable region that event lanes and geometry profiles share. |

## Adding an analysis surface

Add a row to `TOOLS`, and a branch to `ToolPanels`. The component wraps its own
content in `InstrumentPanel` and positions nothing:

```svelte
<InstrumentPanel title="Occultations" width={toolDef('occultations').width} {onClose}>
  …
</InstrumentPanel>
```

That is the whole integration. The rail button, the keyboard shortcut, the dock
placement, the stacking order, the Escape behaviour and the compact bottom-sheet
presentation all follow from the table row.

## Presentations

Most surfaces are `panel`s. Two are not, and both earn it: the catalog is a
full-height browsing `drawer` — a separate contextual instrument, not a second
navigation column — and display settings is a small anchored `menu`. Only
`panel` surfaces are laid out by `PanelDock`; the other two render themselves
and are merely *opened* through the same state. Prefer `panel` unless a surface
has a reason of that kind.

## Measurements

Three CSS variables, published by `App.svelte` onto the shell root:

- `--size-rail` — the rail's width, or `0` when it is horizontal, so left-docked
  surfaces need no compact branch of their own.
- `--size-timeline` — bottom of the viewport to the top of the timeline dock.
- `--size-dock-base` — bottom of the viewport to the top of whatever docks above
  the timeline. Equal to `--size-timeline` on desktop; taller when compact,
  where the rail sits between the two.

The last two come from `bind:clientHeight` on the timeline and the rail rather
than from constants. The timeline's height is not the shell's to choose: it
grows with the expanded lane region, with the shortcut strip, and — at a phone
width, where the transport wraps — with the viewport. The first version used rem
constants, and the wrapped transport promptly grew underneath the rail and
swallowed its clicks.

## Compact

The compact layout is a different presentation of the same state, never a second
feature model: the rail turns horizontal above the timeline, and both docks feed
one bottom-sheet stack. No component has a mobile twin, and
`shell.layout` is the only thing that branches.

## What this is not

The arrangement is a useful default, not information architecture. Panel
positions, widths, chrome and the compact presentation are all meant to be
retuned from real scenes and workflows. Nothing here is a contract except that
panels do not position themselves.
