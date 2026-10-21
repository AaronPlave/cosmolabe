# Drawing and editing planetary surface features

The **Draw** tool (rail, pen icon) annotates a body's surface and edits
writable vector layers, with no GIS server. It builds on the geographic layer
model ([geographic-layers.md](geographic-layers.md)), the renderer
([geographic-vectors.md](geographic-vectors.md)) and the shared scene picking.

## Drawing

1. Choose a layer, or **New layer**: a body in the scene whose reference shape
   is a sphere or oblate ellipsoid, a name, and an explicit coordinate
   convention (planetocentric/planetographic latitude, east/west longitude,
   −180..180 or 0..360). It defaults to the convention of a layer already on
   that body. Nothing is ever read as Earth WGS84.
2. Pick a tool and click the surface:
   - **Point**: one click.
   - **Path**: a click per vertex; **Enter** or a double-click finishes.
   - **Polygon**: a click per corner; **Enter** or a double-click closes it.
   - **Circle**: centre, then a point on the edge.
   - **Ellipse**: centre, end of the long axis, then the short axis.
3. **Backspace** drops the last vertex; **Escape** cancels the draft, and a
   second Escape leaves the tool. The panel has the same buttons for touch.

While a tool is on it owns scene clicks; camera drags still orbit, and a drag
never places a vertex. Selection, the probe and measurement resume when the
tool is off. Starting the probe or a measurement turns the tool off.

The dashed preview follows the pointer on the rendered surface. The readout
beside it (length, perimeter and area, radius, or semi-axes) is measured
**along the drawn edges on the reference shape**. Edges are linear in
longitude and latitude, exactly as the renderer draws them, and lengths and
areas use the equal-area latitude on an ellipsoid. Terrain relief is not
included, so the readout says "reference shape, not terrain".

Circles and ellipses keep their **parameters** (centre, semi-axes, bearing) as
the feature's definition; their ring is generated along geodesics on the
reference shape. Moving one moves its centre, and its radius handle resizes it.
Editing its vertices turns it into an ordinary polygon, and the editor says so.

## Editing

Selecting a feature of an editable layer (from the scene or Surface layers)
shows, in its details:

- **Attributes**: name, category, description and notes, plus any other
  properties. Values keep their JSON type unless retyped.
- **Edit shape**: handles on the feature. Drag a vertex to move it; drag a
  hollow midpoint to insert one; drag the cross to move the whole feature,
  which rotates it about the body's centre so its shape is preserved; tap a
  vertex, then **Delete**, to remove it. A drag previews the result and turns
  red, with the reason, if it would be refused; releasing then changes
  nothing. Handles sit on the drawn surface (globe facets or terrain tiles)
  and hide past the horizon; they are larger on touch screens. Editing never
  starts from an ordinary click on a feature.
- **Duplicate** and **Delete** (confirmed). **Undo**/**Redo** in Draw (Ctrl/⌘ Z,
  Shift Z, Y) cover every edit, 100 steps per layer.

Every edit is checked by the same parser that imports GeoJSON. An edit that
would leave a feature invalid is refused with the parser's reason and changes
nothing: self-intersecting or zero-area rings, holes outside their exterior or
touching each other, fewer than three distinct ring vertices, polygon edges
spanning exactly 180°, and positions outside the declared domain. An edit
changes only its own feature. Holes and Multi parts are kept through edits,
even though the draw tools create only simple polygons.

A **read-only** layer (catalog or imported file) is never modified. *Make
editable copy* in a feature's details copies the layer's original GeoJSON
(coordinates, holes, Multi parts, IDs, properties and foreign members) into
an editable layer with its own ID. The original is hidden while the copy
shows, and the editor says so; show it again from Surface layers.

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
**Catalog** export writes a companion catalog whose `geographicLayers` entry
loads the GeoJSON through the ordinary path with the declared convention.
**Import** (in Draw) reads GeoJSON that carries the extension member as a new
editable layer, keeping IDs, properties, shapes and foreign members. Plain
GeoJSON without it is refused rather than guessed; open it with a companion
catalog instead.

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
