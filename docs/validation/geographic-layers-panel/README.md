# Surface layers panel validation (#198)

`scripts/test-geographic-layers-panel.mjs` drives the real viewer, catalog
loader and UI with pointer and keyboard input against a running dev server:

```sh
cd apps/viewer && npx vite dev --port 5188 --host 127.0.0.1 &
node scripts/test-geographic-layers-panel.mjs   # CL_CHROMIUM, CL_VIEWER_URL, CL_GPU=hardware optional
```

It checks, on `geographic-vectors.json` (synthetic Jezero and lunar features on
reference globes):

- the panel groups both bodies and labels catalog layers read-only;
- search narrows the list; selecting a row highlights it in the scene without
  moving the camera; **Fly to** lands tracking Mars;
- Escape in the search field stays with the field; from the scene it clears the selection;
- clicking the drawn target in 3D selects it, shows its details and highlights its row;
- arrow keys move the shared selection;
- hiding the layer clears the selection with a reason and removes its features from drawing;
- **Filter scene too** draws exactly the listed features;
- the phone layout shows the panel as the one sheet.

On `geographic-vectors-jezero-dense.json` (1,601 features) it checks that only
the rows in view are rendered (17) and that a search settles in tens of
milliseconds. That catalog drapes on the local measured Mars pyramid, which is
not in Git; without it the terrain requests fail and the script tolerates only
that error.

The captures kept here (`layer-view.png`, `feature-view.png`) come from
Chromium with SwiftShader (software GL) at 1280×800: they show layout and
behaviour, not hardware performance. A run writes all its captures and
`panel.json` to `work/geographic/layers-panel`.
