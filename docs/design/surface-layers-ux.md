# Surface layers: one interaction design for browsing, styling and drawing

Status: implemented across #273 (#198), #277 (#199) and #278 (#200). GPU cost
of the vector pass is tracked separately (see #278).
This document is the workflow map and visual proposal that review asked for.

## The problem

Hands-on review of the three PRs together found that the features worked, but
the combined experience was too complex:

- **One narrow panel did seven jobs.** Surface layers held imagery, body
  groups, per-layer actions, source metadata, feature search and filters, the
  full style editor and feature details, all stacked in one column.
- **Too many controls per row.** Each layer row carried a checkbox, a name that
  listed features, then isolate, style, list (again) and expand icons.
- **A second window for drawing.** Draw was a separate panel, and editing a
  feature meant moving between it and Surface layers.
- **Implementation words in the UI.** Users saw terms like "feature
  exceptions", "working copy", "Filter scene too" and coordinate conventions up
  front.

## Patterns borrowed

| Product | Pattern taken | Not taken |
| --- | --- | --- |
| Felt | Layer list where clicking a layer opens its panel; a floating drawing toolbar over the map; a feature card on click | Collaboration and comments |
| Google Earth (Projects) | One panel that drills from list to item, with back navigation; a small card in the scene for the selected place | The full-screen story editor |
| ArcGIS Scene Viewer | A "…" options menu on each layer row for rare actions (order, properties); a popup for the selected feature with a zoom-to action | Toolbars of analysis widgets |
| Mapbox Studio | Choosing a layer opens its style; common properties first, everything else behind "more" | Expressions UI |
| QGIS vertex tool | Drag vertices, drag midpoints to insert, select then Delete; one Done | Snapping and topology options |
| NASA MMGIS | Per-body layer tree with an info panel for the clicked feature; layer info behind a button | Tool rails per instrument |

## The model

```
            ┌────────────── selection decides the view ──────────────┐
  Layers ───click layer──▶ Layer ───click feature──▶ Feature          │
    ▲  ◀────── back ──────   ▲  ◀──── back / Esc ────   │             │
    │                        │                          │             │
    └─ search result ────────┼──────────────────────────┘             │
  3D click on a feature ─────┴─▶ callout (Fly · name) ──name──▶ Feature
  Draw (in Layers or Layer) ─▶ floating draw bar ─finish─▶ Feature (new, named)
  Feature ─Edit shape─▶ floating edit bar ─Done─▶ Feature
```

- **One panel, three views.** *Layers* lists the layers. *Layer* shows one
  layer's features, plus its appearance and information behind disclosures.
  *Feature* shows the selected feature. A breadcrumb goes back.
- **Selection decides the view.** Selecting a feature, from the list, the
  search, the scene or the callout, shows that feature. Clearing the selection
  (back or Escape) shows its layer. Every surface shares one selection, so
  there is no second place that claims to edit the same thing.
- **The scene stays dominant.** Nothing opens over the scene on a 3D click. The
  callout names the selection and offers Fly to; its name opens the Feature
  view.
- **Drawing is a mode, not a window.** A slim toolbar floats at the bottom of
  the scene while drawing or editing: tools, Finish, Undo, Cancel or Done. It
  draws into the layer you are looking at when that layer is yours. Otherwise
  it draws into your notes layer for that body, created on first use. A new
  shape is selected and named in the Feature view.
- **Progressive disclosure.** Everyday actions are visible: show/hide, search,
  select, Fly to, draw. Filters, appearance details, coordinate conventions,
  provenance, import notes, reordering and export are one step away, under a
  disclosure or the "…" menu, and use task words.

## Wireframes (desktop, 340 px panel)

```
 Layers                         Layer                          Feature
 ┌─────────────────────────┐    ┌─────────────────────────┐    ┌─────────────────────────┐
 │ Surface layers        × │    │ ‹ Layers              × │    │ ‹ Jezero science      × │
 │ [Search all features  ] │    │ ● Jezero science  👁  ⋯ │    │ Jezero science target   │
 │ [+ Draw]                │    │ 6 features · Catalog    │    │ Point · Mars            │
 │ MARS                    │    │ [Search this layer    ] │    │ 18.4500°N, 77.4500°E    │
 │ 👁 ● Jezero science   ⋯ │    │ ▸ Filter                │    │ [✈ Fly to] [‹ ›]      ⋯ │
 │ 👁 ● Dense targets    ⋯ │    │ ┌─────────────────────┐ │    │ PROPERTIES              │
 │ 🛰 Imagery · 2        › │    │ │ ⌖ science       Pt  │ │    │ Sol            123      │
 │ MOON                    │    │ │ ⌖ sites         MPt │ │    │ Measurement    0.1234…  │
 │ 👁 ● Lunar regions    ⋯ │    │ │ ⟋ traverse      Ln  │ │    │ ▸ Location and source   │
 │                         │    │ └─────────────────────┘ │    │ ▸ Appearance (#277)     │
 │                         │    │ ▸ Appearance  (#277)    │    │ (yours: name editable,  │
 │                         │    │ ▸ About this layer      │    │                         │
 └─────────────────────────┘    └─────────────────────────┘    └─────────────────────────┘
 Row "⋯": Show only this layer · Move up/down (#277) · About · Edit a copy / Export (#278)
 Feature "⋯": Frame · Copy coordinates · Copy reference · Copy geometry · Duplicate/Delete (#278)
 Your own feature: the name is editable in place and its handles show on selection (#278).

 Scene while drawing (#278):
 ┌──────────────────────────────────────────────────────────┐
 │                       (3D scene)                          │
 │              ┌──────────────────────────────────┐        │
 │              │ Mars notes ▾ │ ⌖ ⟋ ⬠ ◯ ⬭ │ ✓ ↶ ✕ │        │
 │              └──────────────────────────────────┘        │
 └──────────────────────────────────────────────────────────┘
```

On a narrow window the panel is the shell's bottom sheet, as today. Its three
views are the same, one at a time, and the floating bar sits above the
timeline.

## Acceptance scenarios: action counts

These count clicks and key presses, with typing a search term as one action.
"Before" is the stack as reviewed; "after" is this design.

| Scenario | Before | After |
| --- | --- | --- |
| 1. Show a hidden layer and open a named feature ("traverse") | 5: open panel, checkbox, list icon, search, row. Details appear below the list | 4: open panel, eye, search all features, result. The Feature view replaces the list |
| 2. Select a shape in 3D, inspect it, fly to it | 3–4: click, callout (opens the panel at the bottom of a long column, sometimes scrolled), Fly to | 2 to fly (click, callout ✈); 3 to inspect and fly (click, callout name, Fly to) |
| 3. Browse → draw a polygon in a new layer → name it → move a vertex → done | 11 + vertices, across two panels: open Draw, New layer, Create, Polygon, vertices, Enter, find details, name, Save, Edit shape, drag, Done | 5 + vertices, one panel and the floating bar: Draw (a polygon at first), vertices, Enter, name and Enter, drag, Done. The annotations layer is made on the way; handles show on selection, so there is no Edit shape step |
| 4. Desktop and narrow | Two panels can be open; Draw and Surface layers each take a sheet on a phone | One panel or sheet; the floating bar keeps the scene visible |

Selection survives every transition in scenario 3. The new shape is selected
when finished and stays selected while it is edited; Done or back from the
Feature view returns to its layer. All four scenarios are driven, with the
actions counted, by `scripts/test-geographic-layers-panel.mjs` (1, 2) and
`scripts/test-geographic-drawing.mjs` (3).

**Pass 4** (the owner's drawing review on #278) removed what remained between
"Draw" and a named shape:

- The New layer form is no longer a step: shapes go into "My annotations ·
  Body", made on first use in the body's existing convention.
- Drawing ends with the shape selected and the cursor in its name.
- Shape editing follows the selection instead of a mode.
- A read-only feature is copied on its own instead of copying its whole layer.
- Export, rename, delete, import and new layer moved into "…" menus.
- The user's own layers draw and pick over published data by default.

## Review passes

**Pass 1** (first sketch) kept the style editor as a fourth view and Draw as a
tab. Problems:

- A fourth view meant two kinds of "back".
- A Draw tab hid the scene on a phone.
- Global search competed with the per-layer search in the same place.

Changes: appearance became a disclosure in the Layer view; drawing became the
floating bar; global search lives only in the Layers view, and the Layer view
searches its own features.

**Pass 2** (against the scenarios). Problems:

- Scenario 2 still took three steps just to fly.
- Scenario 3 began with a "New layer" form asking for a coordinate convention
  before anything could be drawn.

Changes: the callout gained ✈. The first shape on a body creates "<Body>
notes" in the convention of the body's existing layers, with the form only
behind "New layer…" in the menu.

**Pass 3** (language and density). Renamed:

| Before | After |
| --- | --- |
| Isolate | Show only this layer |
| Filter scene too | Hide non-matching features in 3D |
| Make editable copy | Edit a copy (the original stays unchanged) |
| Feature exception | This feature's colour |
| List features (row icon) | Removed; clicking the row opens the layer |
| Copy stable reference | Moved under ⋯ |

Each layer row now has three targets (eye, name, ⋯), not six. Coordinate
conventions appear only under "Location and source" and "About this layer".

## How the stack converges

- **#273** (layers): the three views, the callout, global search, row and
  feature menus, the information disclosures. Imagery opens as its own row.
- **#277** (styles): *Appearance* in the Layer view (colour, opacity and size
  first; property colouring, labels, line and fill details under "More"). Draw
  order is in the row menu; a feature's own colour is under *Appearance* in the
  Feature view.
- **#278** (editing): the Draw panel and its rail button are gone. *+ Draw* is
  in the Layers and Layer views, with the floating bar for drawing and editing.
  Attributes are edited in the Feature view. New layer, import and export are
  in the menus.
