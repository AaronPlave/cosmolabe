# Geographic style editor validation (#199)

`scripts/test-geographic-style-editor.mjs` drives the real viewer, shader and
UI on `geographic-vectors.json` (the synthetic Jezero mixed-geometry fixture on
a reference globe) against a running dev server:

```sh
cd apps/viewer && npx vite dev --port 5188 --host 127.0.0.1 &
node scripts/test-geographic-style-editor.mjs   # CL_CHROMIUM, CL_VIEWER_URL, CL_GPU=hardware optional
```

Through the editor's controls it sets 16 px halo diamonds, 5 px dashed lines,
40 % hatched fills with 4 px outlines, then colours by `name` and turns labels
on. It asserts:

- no shader, page or console errors;
- the edits restyle in place: same batch count, the same record texture and
  material (no recompile), unchanged texture memory, `metrics.restyles` > 0;
- the legend lists the actual values;
- labels appear, bounded and decluttered;
- the style survives a reload of the same catalog;
- Revert undoes changes since the editor opened, and Reset returns to the
  catalog defaults and removes the labels.

Captures (`defaults.png`, `styled.png`, `category.png`, `labels.png`,
`compact.png`) come from Chromium with SwiftShader at 1280×800 and 390×844:
they show behaviour and appearance, not hardware performance.
[`editor.json`](editor.json) holds the recorded results.
