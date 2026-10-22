# Drawing and editing planetary surface features

**Draw** annotates a body's surface and edits your own vector layers, with no
GIS server. It is a small tool state, not a window: a bar floats over the scene
while you draw or edit, and the selected shape is named and described in the
Surface layers panel's Feature view (docs/design/surface-layers-ux.md). It
builds on the geographic layer model ([geographic-layers.md](geographic-layers.md)),
the renderer ([geographic-vectors.md](geographic-vectors.md)) and the shared
scene picking.

## Drawing

1. **Draw** (in Surface layers, beside the search or in a layer's view, or
   "Draw a polygon/path/point" in the command palette) starts with the last
   tool used, a polygon at first.
2. Click the surface:
   - **Point**: one click.
   - **Path**: a click per point; **Enter** or a double-click finishes.
   - **Polygon**: a click per corner; **Enter** or a double-click closes it.
   - **Circle**: centre, then a point on the edge.
   - **Ellipse**: centre, end of the long axis, then the short axis.
3. When the shape is finished, drawing ends and the shape is selected. Its
   Feature view opens with the name ready to type.

**Backspace** drops the last point; **Escape** clears the draft, and a second
Escape stops drawing. The bar has the same controls for touch, and switches
tools without leaving drawing.

**Where shapes go.** Into the layer being looked at when it is one of yours;
otherwise into the last layer drawn into on that body; otherwise into
**My annotations · Body**, made on first use. A new annotations layer takes
the coordinate convention of the body's existing layers (planetocentric or
planetographic latitude, east or west longitude, −180..180 or 0..360) on the
body's reference shape, so drawing needs no setup. If nothing is drawn into a
layer made this way, it is removed again. With more than one of your layers on
the body, the bar lets you switch. Nothing is ever read as Earth WGS84.

While a tool is on it owns scene clicks; camera drags still orbit, and a drag
never places a point. Selection, the probe and measurement resume when drawing
stops. Starting the probe or a measurement stops drawing.

The dashed preview follows the pointer on the rendered surface. The bar
measures the draft (length, area, radius or semi-axes) **along the drawn edges
on the reference shape**. Edges are linear in longitude and latitude, exactly as
the renderer draws them, and lengths and areas use the equal-area latitude on
an ellipsoid. Terrain relief is not included.

Circles and ellipses keep their **parameters** (centre, semi-axes, bearing) as
the feature's definition; their ring is generated along geodesics on the
reference shape. Moving one moves its centre, and its radius handle resizes it.
Editing its points turns it into an ordinary polygon.

## Editing

Selecting one of your own shapes, in the scene or the panel, shows its handles
straight away; there is no separate edit mode. Drag a point to move it, drag a
hollow midpoint to insert one, drag the cross to move the whole shape (it
rotates about the body's centre, so its shape is preserved), or click a point
and press **Delete** to remove it. A drag previews the result and turns red,
with the reason, if it would be refused; releasing then changes nothing.
Handles sit on the drawn surface (globe facets or terrain tiles), hide past the
horizon and are larger on touch screens. The bar offers Delete point, Undo,
Redo (Ctrl/⌘ Z, Shift Z, Y; 100 steps per layer) and **Done**, which ends the
selection. Your layers draw and pick over published data unless their draw
order is changed.

The Feature view of your own shape shows:

- **Name**, edited in place (Enter or leaving the field saves it).
- Its length or area on the reference shape, and its layer.
- **Properties**: each with an explicit type (text, number, yes/no, empty or
  JSON) that it keeps while its value is edited; a new property takes the type
  chosen for it. A number that does not parse, or broken JSON, holds Save back
  rather than being saved as text.
- **Duplicate** and **Delete…** (confirmed) in its **…** menu.

Every edit is checked by the same parser that imports GeoJSON. An edit that
would leave a feature invalid is refused with the parser's reason and changes
nothing: self-intersecting or zero-area rings, holes outside their exterior or
touching each other, fewer than three distinct ring vertices, polygon edges
spanning exactly 180°, and positions outside the declared domain. An edit
changes only its own feature. Holes and Multi parts are kept through edits,
even though the draw tools create only simple polygons.

A **read-only** layer (catalog or imported file) is never modified. *Edit a
copy of this feature* in its Feature view (or *Copy to my annotations* in its
**…** menu) copies just that feature, with its properties and a `copiedFrom`
reference, into the body's annotations layer in that layer's convention, and
selects the copy, ready to edit. To edit a whole published layer, *Edit a copy
of this layer* in its **…** menu copies its original GeoJSON (coordinates,
holes, Multi parts, IDs, properties and foreign members) into an editable layer
with its own ID; the original is hidden while the copy shows.

## Saving, export and import

Editable layers are kept in this browser's localStorage under
`cosmolabe-geographic-edits`: `{ format: "cosmolabe-geographic-edits",
version: 1, layers: [...] }`, at most 16 layers and 4 MiB, each within the
import limits (5,000 features, 50,000 vertices). Each layer stores its body,
convention, the ID of any layer it copies, and its features with coordinates
**in the declared convention**, exactly as exported. On reload every layer is
re-validated, and damaged layers or features are reported and left out.
Layers appear in any scene that has their body. Styles are separate
([geographic-layers.md](geographic-layers.md#layer-styles)).

**GeoJSON** export writes a FeatureCollection with the planetary extension
member `cosmolabe:geographic`
(`{ version, body, frame, coordinates, layer: { id, name }, basedOn? }`), and
each circle or ellipse carries `cosmolabe:shape`. Coordinates are written as
stored, so export → import returns the same numbers. Software that follows RFC
7946 strictly will read the coordinates as Earth WGS84; the panel says so.
Export is in the layer's **…** menu: *Export GeoJSON*, and *Export catalog for
it*, a companion catalog whose `geographicLayers` entry loads the GeoJSON
through the ordinary path with the declared convention. Rename and delete are
there too. **Import GeoJSON…** (the Layers view's **…** menu) reads GeoJSON that carries the extension member as a new
editable layer, keeping IDs, properties, shapes and foreign members. Plain
GeoJSON without it is never guessed (RFC 7946 would mean Earth WGS84): Import
opens a form for the body and the latitude convention and longitude direction
and range it was written in. *New layer…* in the same menu makes an empty
layer with a chosen name, body and convention; drawing never needs it. The coordinates are read in that convention and kept
as written, never reprojected, and the layer is stored and exported with it.
A companion catalog remains the way to load such a file read-only.

## Performance

Edits are committed when a drag ends, not while it moves. Measured in Node on
a working copy of the dense Jezero fixture (median of 15):

| Working copy | Drag preview (per move) | Commit | Vector rebuild (per commit) | Stored |
| --- | --- | --- | --- | --- |
| 1,601 features, 1,761 vertices | 1.6 ms | 17–20 ms | ~50 ms | 194 KiB |
| 4,803 features, 5,283 vertices | 1.6 ms | 40–45 ms | ~50 ms | 581 KiB |

A commit is the core edit (about 1.6 ms, only the changed feature is
validated), converting the working copy into a scene layer (15 ms and 44 ms;
the whole layer is re-read), saving (2–7 ms), then one rebuild of the
renderer's vector index. Undo and redo cost the same as a commit.

## Library

`@cosmolabe/core` exposes the model without the viewer:
`createGeographicEditLayer`, `createGeographicWorkingCopy`,
`applyGeographicEdit` and `GeographicEditSession` (operations, validation,
undo/redo), `geographicShapeRing`, `geographicEditLayerToLayer` (for drawing
and picking), `exportGeographicEditLayer`, `importGeographicEditLayer`,
`geographicEditCompanionCatalog`, and `serializeGeographicEditDocument` /
`parseGeographicEditDocument`. `geodesicDirect`, `geodesicDistanceKm`,
`geographicPathLengthKm` and `geographicPolygonAreaKm2` measure on the
reference shape. The renderer adds `renderedSurfaceHeightsKm` for overlays
that must sit on the drawn surface.

## Not included

Collaborative editing, snapping, topology-aware boolean operations, route
optimization, elevation profiles and cross-layer geoprocessing. Feature
heights are not authored: drawn positions are two-dimensional and drape on the
surface.
