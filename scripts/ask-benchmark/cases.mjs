/** Versioned prompts and independent final-state checks; no runtime mission routing. */
export const cases = [
  { id: 'select-earth', catalog: 'earth-moon', prompt: 'Select Earth.', selected: 'Earth' },
  { id: 'pause-select', catalog: 'earth-moon', prompt: 'Pause time and select the Moon.', selected: 'Moon', paused: true },
  { id: 'authored-viewpoint', catalog: 'earth-moon', prompt: 'Show the Lunar Orbit viewpoint and pause time.', range: 900000, paused: true },
  { id: 'ambiguous-flight', catalog: 'ingenuity-jezero', prompt: 'Show the next flight.', unchanged: true,
    rubric: 'Ask which flight or reference time; do not invent a next flight without context.' },
  { id: 'longest-flight', catalog: 'ingenuity-jezero', prompt: "Show me Ingenuity's longest flight by duration, pause at its start, frame the helicopter, and tell me what imagery is available on Mars.", activity: 'ingenuity:flight:12', tracked: 'Ingenuity', paused: true, frame: true, inventory: 'getImagery',
    rubric: 'Flight 12, 169.5 s, estimated timing. All four layer names and attributions; distinguish degraded fallback tiles from loaded/healthy imagery.' },
  { id: 'exact-flight', catalog: 'ingenuity-jezero', prompt: 'Show Ingenuity Flight 5, pause at its start, and frame the helicopter. Explain the timing provenance.', activity: 'ingenuity:flight:5', tracked: 'Ingenuity', paused: true, frame: true,
    rubric: 'Flight 5 at its observed start; MMGIS approximate epochs, uncalibrated drift, estimated 3D playback, not precise telemetry.' },
  { id: 'landing-site', catalog: 'moonfall-shackleton', prompt: 'Take me to the MoonFall landing site near Shackleton, pause time, and explain whether this is a real mission operation.', place: 'moon:mission:moonfall-sites/psr-landing', paused: true,
    rubric: 'Exact PSR landing waypoint. Authored synthetic demonstration, not a real planned/observed mission operation.' },
  { id: 'mars-inventory', catalog: 'ingenuity-jezero', prompt: 'List the imagery available on Mars, with each layer attribution and its current loading status. Do not move the camera or time.', unchanged: true, inventory: 'getImagery',
    rubric: 'Four layers with exact source attributions; status at observation time, including fallback/degraded/pending states. No coverage assertion from configuration.' },
  { id: 'moon-provenance', catalog: 'moonfall-shackleton', prompt: 'Which terrain and imagery datasets are configured for the Moon? Give provenance and distinguish configured, loaded, and unknown coverage. Do not move the view or time.', unchanged: true, inventory: 'getSurfaceData',
    rubric: 'LOLA terrain, LROC WAC/NAC imagery; withheld fields remain withheld. coversView null means unknown; configuration is not readiness.' },
  { id: 'unsupported-measurement', catalog: 'earth-moon', prompt: 'Create a persistent measured distance annotation between Earth and Moon. If this capability is unavailable, explain that and leave the scene unchanged.', unchanged: true,
    rubric: 'Explicit unavailable capability; no fabricated measurement or annotation. Discovery searches appropriate domains before refusal.' },
  { id: 'cancel-after-write', catalog: 'earth-moon', prompt: 'Pause time, select the Moon, show Lunar Orbit, and explain the final view.', cancel: true,
    rubric: 'Harness stops at next transport boundary after a completed write; no later writes or automatic replay. Already applied changes remain.' },
  { id: 'unresolved-viewpoint', catalog: 'earth-moon', prompt: 'Show that viewpoint.', unchanged: true,
    rubric: 'Fresh conversation with no viewpoint reference; Earth Close and Lunar Orbit are both available and both center on Earth. Ask which viewpoint without changing the scene.' },
  { id: 'mixed-workflow', catalog: 'earth-moon', prompt: 'Pause time, select the Moon, show Lunar Orbit, then tell me the selected object and whether time is paused.', selected: 'Moon', paused: true, range: 900000 },
];

export function scoreState(test, initial, result) {
  const checks = {};
  const state = result.state;
  if (test.selected) checks.selection = state.selected === test.selected;
  if (test.tracked) checks.tracking = state.tracked === test.tracked;
  if (test.paused) checks.paused = state.playing === false;
  if (test.activity) {
    checks.activity = state.activity?.id === test.activity;
    checks.startEt = !!state.activity && Math.abs(state.et - state.activity.start) < 0.001;
  }
  if (test.place) checks.place = state.place?.ref === test.place;
  if (test.range) checks.viewpointRange = Math.abs(Math.hypot(...state.camera.position) - test.range) < 1;
  if (test.frame) {
    // A host return alone is insufficient. The probe independently projects the
    // object's center into the actual loaded camera's viewport.
    checks.framing = state.framing?.inView === true && state.framing?.occupiesViewport === true;
  }
  if (test.inventory) checks.inventoryRead = result.steps.some(s => s.name.split('.').at(-1) === test.inventory && s.ok);
  if (test.unchanged) checks.unchanged = JSON.stringify(state.stable) === JSON.stringify(initial.stable);
  if (test.cancel) {
    checks.cancelled = result.status === 'cancelled';
    checks.writeBeforeStop = result.cancel?.afterWrite === true;
    checks.noLateMutation = result.cancel?.unchanged === true;
  } else checks.finished = result.status === 'done';
  return { checks, passed: Object.values(checks).every(Boolean),
    // Factual scoring must be reviewed against observations, never inferred
    // from a fluent answer, successful tool return or passing state checks.
    factual: { verdict: 'pending-review', rubric: test.rubric ?? 'Answer agrees with observed final selection, clock and authored viewpoint.' } };
}

export function summarizeUsage(rows) {
  const sum = key => rows.reduce((n, r) => n + r[key], 0);
  return { requests: rows.length, requestedModels: [...new Set(rows.map(r => r.requestedModel))],
    answeredModels: [...new Set(rows.map(r => r.model))], uncachedInput: sum('inputTokens'),
    cacheReads: sum('cacheReadTokens'), cacheWrites: sum('cacheWriteTokens'), output: sum('outputTokens'),
    rawProcessed: sum('inputTokens') + sum('cacheReadTokens') + sum('cacheWriteTokens') + sum('outputTokens'),
    estimatedUsd: rows.length && rows.every(r => r.estimatedUsd !== null) ? sum('estimatedUsd') : null,
    actualBilledUsd: null };
}
