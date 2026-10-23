# Surface drawing and editing validation (#200)

`scripts/test-geographic-drawing.mjs` drives the real viewer and UI with
pointer and keyboard input on `geographic-vectors.json` (synthetic Mars and
lunar features on reference globes) against a running dev server:

```sh
cd apps/viewer && npx vite dev --port 5188 --host 127.0.0.1 &
node scripts/test-geographic-drawing.mjs   # CL_CHROMIUM, CL_VIEWER_URL, CL_GPU=hardware optional
```

On Mars, in a new layer that takes the existing Mars layer's convention
(planetocentric, east, 0–360°), it:

- places a point and checks that it is drawn and picked under the click;
- draws a path, drags the camera mid-draft (it navigates and adds no vertex),
  and finishes with Enter;
- is refused a self-crossing polygon, with the reason, and nothing is added;
- closes a polygon with a double-click, then undoes and redoes it;
- draws a circle and an ellipse, which keep their parameters;
- edits a polygon's attributes, drags a vertex handle and a midpoint handle
  (insert), and keeps the ring closed;
- reloads and gets the identical stored layer back;
- exports GeoJSON (body, frame and convention in `cosmolabe:geographic`,
  identical coordinates), and imports it as a new layer with identical features;
- makes an editable copy of the read-only catalog layer, hiding the original
  and leaving it unchanged.

On the Moon it creates a layer in the Moon layer's planetographic −180..180°
sphere convention and places a point near the south pole. No page or console
errors are allowed.

The captures (`path-preview.png`, `edit-handles.png`, `moon.png`,
`compact.png`) come from Chromium with SwiftShader at 1280×800 and 390×844.
[`drawing.json`](drawing.json) holds the recorded results. On a coarse
reference globe a click lands on the drawn facets, a few hundred metres from
the ideal ellipsoid point; drawing, picking and handles all use that same
drawn surface, so what is clicked is what is drawn.
