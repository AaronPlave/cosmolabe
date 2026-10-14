/**
 * Which keys each kind of catalog node may carry, and a check that reports
 * any other key.
 *
 * A catalog key the loader does not read is not an error to JSON, so before
 * this check it was silently dropped and the scene still rendered, just
 * without what the key asked for. A rotation written with `axes` instead of
 * `sequence` loaded with no attitude at all; a viewpoint `time` the loader did
 * not read left the clock decades away from the flyby the viewpoint was named
 * for. Each one looked like a plausible scene.
 *
 * The tables below list what the code actually reads, per node type: the
 * loader's fields, and the geometry fields the renderers read from
 * `Body.geometryData`. Any other key is reported at the node that owns it,
 * with the nearest valid key, or the node it belongs in when it is valid
 * somewhere nearby (`visible` inside `trajectory` belongs in `trajectoryPlot`).
 *
 * A node whose `type` this module does not know (a custom trajectory or
 * rotation factory, a plugin geometry) is not checked field by field, since
 * its fields belong to code this module cannot see. An unknown trajectory or
 * rotation `type` is itself reported unless a custom factory handles it,
 * because the loader turns one into a body fixed at its parent's origin, or
 * into no rotation at all.
 */

/** One unknown key or type, at the node that owns it. */
export interface CatalogDiagnostic {
  /** JSON path to the offending key, e.g. `$.items[2].rotationModel.axes`. */
  path: string;
  /** What the owning node is, e.g. `FixedEuler rotationModel of "Cassini"`. */
  node: string;
  /** The key (or, for an unknown `type`, the type value) that was not recognized. */
  key: string;
  /** The valid key or type it most likely meant, when one is close. */
  suggestion?: string;
  /** A ready-to-print sentence naming all of the above. */
  message: string;
}

export interface CatalogValidationOptions {
  /** Trajectory `type`s a custom factory handles; their fields are not checked. */
  trajectoryTypes?: readonly string[];
  /** Rotation `type`s a custom factory handles; their fields are not checked. */
  rotationTypes?: readonly string[];
}

type KeySet = ReadonlySet<string>;
const keys = (...k: string[]): KeySet => new Set(k);

// ── Catalog and item level ──────────────────────────────────────────────────

const CATALOG_KEYS = keys(
  'name', 'version', 'require', 'items', 'spiceKernels', 'spkImport',
  'defaultTime', 'defaultViewpoint', 'frames',
);

const ITEM_KEYS = keys(
  'name', 'type', 'class', 'center', 'trajectoryFrame', 'trajectory', 'trajectoryPlot',
  'rotationModel', 'bodyFrame', 'geometry', 'label', 'naifId', 'mass', 'radii',
  'startTime', 'endTime', 'items', 'arcs', 'spiceKernels',
);

const VIEWPOINT_KEYS = keys(
  'name', 'type', 'center', 'frame', 'distance', 'longitude', 'latitude',
  'eye', 'target', 'up', 'fov', 'time',
);

/** Item types the loader skips without building a body: their content is
 *  overlay metadata it never reads, so it is not checked either. */
const SKIPPED_ITEM_TYPES = new Set(['Visualizer', 'FeatureLabels']);

const ARC_KEYS = keys(
  'center', 'trajectoryFrame', 'trajectory', 'bodyFrame', 'startTime', 'endTime',
  'showLine', 'numKeySamples',
  // Cosmographia arcs carry a rotation and geometry of their own; the loader
  // does not read them, so they are reported rather than listed here.
);

const TRAJECTORY_PLOT_KEYS = keys(
  'duration', 'lead', 'fade', 'color', 'opacity', 'visible', 'sampleCount', 'lineWidth',
);

const LABEL_KEYS = keys('color', 'visible');

const WAYPOINT_KEYS = keys('t', 'lat', 'latitude', 'lon', 'longitude', 'alt', 'altitude');

const FRAME_SPEC_KEYS = keys('name', 'base', 'quaternion', 'matrix');

const SPK_IMPORT_KEYS = keys('kernel', 'center', 'naifIdRange', 'defaults', 'nameTemplate');

const STRUCTURED_FRAME_KEYS = keys('type', 'body');

// ── Trajectories ────────────────────────────────────────────────────────────

/** `distanceUnits` scales FixedPoint, Keplerian and FixedSpherical positions,
 *  and is harmless anywhere else, so every trajectory may carry it. */
const TRAJECTORY_COMMON = ['type', 'distanceUnits'];

const TRAJECTORY_KEYS: Record<string, KeySet> = {
  FixedPoint: keys(...TRAJECTORY_COMMON, 'position'),
  FixedSpherical: keys(...TRAJECTORY_COMMON, 'latitude', 'longitude', 'radius'),
  Keplerian: keys(
    ...TRAJECTORY_COMMON, 'semiMajorAxis', 'eccentricity', 'inclination', 'ascendingNode',
    'argOfPeriapsis', 'argumentOfPeriapsis', 'meanAnomaly', 'epoch', 'period',
  ),
  Builtin: keys(...TRAJECTORY_COMMON, 'name'),
  Spice: keys(...TRAJECTORY_COMMON, 'target', 'center'),
  InterpolatedStates: keys(...TRAJECTORY_COMMON, 'source', 'samples'),
  OEM: keys(...TRAJECTORY_COMMON, 'source'),
  ChebyshevPoly: keys(...TRAJECTORY_COMMON, 'source', 'period'),
  TLE: keys(...TRAJECTORY_COMMON, 'line1', 'line2', 'windowDays'),
  LinearCombination: keys(...TRAJECTORY_COMMON, 'trajectories', 'weights', 'period'),
  Composite: keys(...TRAJECTORY_COMMON, 'arcs', 'segments'),
  Waypoints: keys(...TRAJECTORY_COMMON, 'referenceRadius', 'epoch', 'waypoints', 'useAbsoluteAlt'),
  TASS17: keys(...TRAJECTORY_COMMON, 'satellite', 'name'),
  L1: keys(...TRAJECTORY_COMMON, 'satellite', 'name'),
  Gust86: keys(...TRAJECTORY_COMMON, 'satellite', 'name'),
  MarsSat: keys(...TRAJECTORY_COMMON, 'satellite', 'name'),
};

// ── Rotation models ─────────────────────────────────────────────────────────

const ROTATION_KEYS: Record<string, KeySet> = {
  Builtin: keys('type', 'name'),
  Uniform: keys(
    'type', 'period', 'epoch', 'meridianAngle', 'inclination', 'ascendingNode',
    'ascension', 'declination', 'inertialFrame',
  ),
  Fixed: keys('type', 'quaternion', 'inclination', 'ascendingNode', 'meridianAngle', 'inertialFrame'),
  FixedEuler: keys('type', 'sequence', 'angles', 'inertialFrame'),
  Interpolated: keys('type', 'source', 'records', 'inertialFrame'),
  Spice: keys('type', 'bodyFrame', 'inertialFrame'),
  Nadir: keys('type', 'target', 'center', 'inertialFrame'),
  SurfaceUp: keys('type'),
};

// ── Geometry (read by the renderers from Body.geometryData) ─────────────────

/** Keys any geometry may carry: the loader reads `radius`/`radii`; the three
 *  renderer reads `emissive`, `castShadow` and `surfaceLock` on any body; the
 *  Cesium renderer draws any geometry with `lat`/`lon` as a surface point. */
const GEOMETRY_COMMON = [
  'type', 'radius', 'radii', 'emissive', 'castShadow', 'surfaceLock',
  'lat', 'lon', 'alt', 'group',
];

/**
 * Field-checked geometry types. Types that no renderer draws (`Axes`,
 * `KeplerianSwarm`, `ParticleSystem`, `TimeSwitched`, …) are left out, and so
 * are plugin types: every field of the former is equally unread, so naming
 * one of them would be noise, and the latter's fields belong to the plugin.
 */
const GEOMETRY_KEYS: Record<string, KeySet> = {
  Globe: keys(
    ...GEOMETRY_COMMON, 'baseMap', 'normalMap', 'displacementMap', 'displacementScale',
    'displacementBias', 'bumpMap', 'bumpScale', 'atmosphere', 'terrain', 'surfaceTiles',
  ),
  Mesh: keys(...GEOMETRY_COMMON, 'source', 'size', 'scale', 'meshRotation', 'meshOffset'),
  Sensor: keys(
    ...GEOMETRY_COMMON, 'target', 'spiceId', 'shape', 'horizontalFov', 'verticalFov', 'range',
    'orientation', 'frustumColor', 'frustumOpacity',
  ),
  Rings: keys(...GEOMETRY_COMMON, 'innerRadius', 'outerRadius', 'texture'),
};

/** A nested object's allowed keys, and its own nested objects. An array value
 *  is checked element by element; a string or boolean value is not checked. */
interface NestedSpec {
  keys: KeySet;
  children?: Record<string, NestedSpec>;
}

const IMAGERY: NestedSpec = {
  keys: keys(
    'type', 'url', 'levels', 'dimension', 'projection', 'layer', 'tileMatrixSet',
    'crs', 'format', 'styles', 'version', 'transparent',
    'bounds', 'minZoom', 'endCaps', 'opacity', 'color', 'time',
  ),
};

const SURFACE_LOCK: NestedSpec = { keys: keys('mode') };

const GEOMETRY_NESTED: Record<string, Record<string, NestedSpec>> = {
  Globe: {
    baseMap: { keys: keys('type', 'template', 'topLayer') },
    atmosphere: {
      keys: keys(
        'mieCoeff', 'mieScaleHeight', 'rayleighCoeff', 'heightKm', 'rayleighScaleHeightKm',
        'mieExtinctionCoeff', 'groundAlbedo', 'miePhaseAsymmetry', 'absorptionCoeff',
        'planetCapBias', 'absorptionProfile',
      ),
      children: {
        absorptionProfile: { keys: keys('type', 'peakKm', 'halfWidthKm', 'scaleHeightKm') },
      },
    },
    terrain: {
      keys: keys(
        'type', 'url', 'cesiumIonAssetId', 'cesiumIonToken', 'imagery', 'errorTarget',
        'maxCacheBytes', 'normalMapUrl', 'normalMapStrength', 'preloadAtPixels', 'showAtPixels',
        'referenceRadiusOffsetKm', 'samplerMaxTiles', 'skirtLength', 'skirtScale',
        'fadeDurationMs', 'overlayResolution', 'datum', 'sourceMetadata',
      ),
      children: {
        imagery: IMAGERY,
        datum: { keys: keys('verticalDatum', 'heightConvention') },
        sourceMetadata: { keys: keys('id', 'kind', 'url', 'uncertaintyKm', 'version') },
      },
    },
    surfaceTiles: {
      keys: keys('name', 'url', 'lat', 'lon', 'altitudeOffset', 'errorTarget', 'maxCacheBytes'),
    },
    surfaceLock: SURFACE_LOCK,
  },
  Mesh: { surfaceLock: SURFACE_LOCK },
  Sensor: { surfaceLock: SURFACE_LOCK },
  Rings: { surfaceLock: SURFACE_LOCK },
};

// ── Known wrong names ───────────────────────────────────────────────────────

/**
 * Names that have been written in good faith and silently dropped, mapped to
 * what the loader reads. Edit distance cannot find most of these (`axes` is
 * nowhere near `sequence`), so they are named outright. Keyed by node kind:
 * `trajectory:<type>`, `rotation:<type>`, `item`, `viewpoint`, `arc`, or `*`.
 */
const KNOWN_ALIASES: Record<string, Record<string, Fix>> = {
  'trajectory:Keplerian': {
    longitudeOfAscendingNode: { key: 'ascendingNode' },
    raan: { key: 'ascendingNode' },
    argumentOfPerihelion: { key: 'argumentOfPeriapsis' },
  },
  'trajectory:Spice': {
    frame: { key: 'trajectoryFrame', where: 'on the item' },
  },
  'trajectory:Composite': {
    startEt: { key: 'startTime', where: 'on each arc' },
    endEt: { key: 'endTime', where: 'on each arc' },
    startTime: { key: 'startTime', where: 'on each arc' },
    endTime: { key: 'endTime', where: 'on each arc' },
  },
  'trajectory:LinearCombination': {
    terms: { key: 'trajectories', note: 'with a parallel "weights" array' },
  },
  'trajectory:ChebyshevPoly': {
    coefficients: { key: 'source', note: 'coefficients are read from a .cheb file' },
    interval: { key: 'source', note: 'coefficients are read from a .cheb file' },
  },
  'rotation:FixedEuler': {
    axes: { key: 'sequence' },
  },
  'rotation:Interpolated': {
    samples: { key: 'records', note: 'or "source", a .q file' },
  },
  'rotation:Spice': {
    frame: { key: 'bodyFrame' },
  },
  arc: {
    startEt: { key: 'startTime' },
    endEt: { key: 'endTime' },
  },
};

/** What to write instead: a key, optionally in another node, with a note. */
interface Fix {
  key: string;
  where?: string;
  note?: string;
}

const describeFix = (fix: Fix): string =>
  `Did you mean "${fix.key}"${fix.where ? ` ${fix.where}` : ''}?${fix.note ? ` (${fix.note})` : ''}`;

// ── The check ───────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Report every key in `json` that no node of its kind accepts. Returns the
 * diagnostics rather than printing them, so a caller can decide; the loader
 * prints each once.
 */
export function validateCatalog(json: unknown, options: CatalogValidationOptions = {}): CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = [];
  if (!isObject(json)) return out;
  const customTrajectories = new Set(options.trajectoryTypes ?? []);
  const customRotations = new Set(options.rotationTypes ?? []);

  const report = (path: string, node: string, key: string, fix: Fix | undefined) => {
    out.push({
      path: `${path}.${key}`,
      node,
      key,
      suggestion: fix?.key,
      message: `unknown key "${key}" on ${node} (${path}) is not read and has no effect.` +
        (fix ? ` ${describeFix(fix)}` : ''),
    });
  };

  /** Check `obj`'s own keys against `allowed`, suggesting a fix for each miss.
   *  `siblings` are the nodes a misplaced key most likely belongs in. */
  const checkKeys = (
    obj: Json,
    allowed: KeySet,
    path: string,
    node: string,
    aliasKind: string,
    siblings: Array<[string, KeySet]> = [],
  ) => {
    for (const key of Object.keys(obj)) {
      if (allowed.has(key)) continue;
      report(path, node, key, suggest(key, allowed, aliasKind, siblings));
    }
  };

  const checkTrajectory = (spec: unknown, path: string, owner: string) => {
    if (!isObject(spec)) return;
    const type = typeof spec.type === 'string' ? spec.type : undefined;
    if (type === undefined) return;
    if (customTrajectories.has(type)) return;
    const allowed = TRAJECTORY_KEYS[type];
    if (!allowed) {
      const near = nearest(type, Object.keys(TRAJECTORY_KEYS));
      out.push({
        path: `${path}.type`,
        node: `trajectory of ${owner}`,
        key: type,
        suggestion: near,
        message:
          `unknown trajectory type "${type}" on ${owner} (${path}); the body is fixed at its parent's origin.` +
          (near ? ` Did you mean "${near}"?` : ` Known types: ${Object.keys(TRAJECTORY_KEYS).join(', ')}.`),
      });
      return;
    }
    const node = `${type} trajectory of ${owner}`;
    checkKeys(spec, allowed, path, node, `trajectory:${type}`, [
      ['trajectoryPlot', TRAJECTORY_PLOT_KEYS],
      ['the item', ITEM_KEYS],
    ]);
    for (const listKey of ['arcs', 'segments'] as const) {
      const arcs = spec[listKey];
      if (Array.isArray(arcs)) arcs.forEach((a, i) => checkArc(a, `${path}.${listKey}[${i}]`, owner, i));
    }
    if (Array.isArray(spec.trajectories)) {
      spec.trajectories.forEach((t, i) => checkTrajectory(t, `${path}.trajectories[${i}]`, owner));
    }
    if (Array.isArray(spec.waypoints)) {
      spec.waypoints.forEach((w, i) => {
        if (isObject(w)) checkKeys(w, WAYPOINT_KEYS, `${path}.waypoints[${i}]`, `waypoint ${i} of ${owner}`, 'waypoint');
      });
    }
  };

  const checkArc = (arc: unknown, path: string, owner: string, index: number) => {
    if (!isObject(arc)) return;
    checkKeys(arc, ARC_KEYS, path, `arc ${index} of ${owner}`, 'arc', [['the item', ITEM_KEYS]]);
    checkTrajectory(arc.trajectory, `${path}.trajectory`, `${owner} (arc ${index})`);
    checkFrameRef(arc.trajectoryFrame, `${path}.trajectoryFrame`, `${owner} (arc ${index})`);
  };

  const checkFrameRef = (frame: unknown, path: string, owner: string) => {
    if (isObject(frame)) checkKeys(frame, STRUCTURED_FRAME_KEYS, path, `trajectoryFrame of ${owner}`, 'frame');
  };

  const checkRotation = (spec: unknown, path: string, owner: string) => {
    if (!isObject(spec)) return;
    const type = typeof spec.type === 'string' ? spec.type : undefined;
    if (type === undefined) return;
    if (customRotations.has(type)) return;
    const allowed = ROTATION_KEYS[type];
    if (!allowed) {
      const near = nearest(type, Object.keys(ROTATION_KEYS));
      out.push({
        path: `${path}.type`,
        node: `rotationModel of ${owner}`,
        key: type,
        suggestion: near,
        message:
          `unknown rotationModel type "${type}" on ${owner} (${path}); the body has no orientation.` +
          (near ? ` Did you mean "${near}"?` : ` Known types: ${Object.keys(ROTATION_KEYS).join(', ')}.`),
      });
      return;
    }
    checkKeys(spec, allowed, path, `${type} rotationModel of ${owner}`, `rotation:${type}`, [['the item', ITEM_KEYS]]);
  };

  const checkGeometry = (spec: unknown, path: string, owner: string) => {
    if (!isObject(spec)) return;
    const type = typeof spec.type === 'string' ? spec.type : undefined;
    const allowed = type !== undefined ? GEOMETRY_KEYS[type] : undefined;
    // An unknown geometry type may be a plugin's; its fields are not ours to judge.
    if (!type || !allowed) return;
    const node = `${type} geometry of ${owner}`;
    checkKeys(spec, allowed, path, node, `geometry:${type}`);
    checkNested(spec, GEOMETRY_NESTED[type] ?? {}, path, node, `geometry:${type}`);
  };

  const checkNested = (parent: Json, children: Record<string, NestedSpec>, path: string, node: string, kind: string) => {
    for (const [key, nested] of Object.entries(children)) {
      const value = parent[key];
      const visit = (v: unknown, p: string, n: string) => {
        if (!isObject(v)) return;
        checkKeys(v, nested.keys, p, n, `${kind}.${key}`);
        if (nested.children) checkNested(v, nested.children, p, n, `${kind}.${key}`);
      };
      if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}.${key}[${i}]`, `${key}[${i}] of ${node}`));
      else visit(value, `${path}.${key}`, `${key} of ${node}`);
    }
  };

  const checkItem = (item: unknown, path: string) => {
    if (!isObject(item)) return;
    const name = typeof item.name === 'string' ? item.name : '(unnamed)';
    const owner = `"${name}"`;
    if (item.type === 'Viewpoint') {
      checkKeys(item, VIEWPOINT_KEYS, path, `viewpoint ${owner}`, 'viewpoint');
      return;
    }
    if (typeof item.type === 'string' && SKIPPED_ITEM_TYPES.has(item.type)) return;
    checkKeys(item, ITEM_KEYS, path, `item ${owner}`, 'item', [['a Viewpoint', VIEWPOINT_KEYS]]);
    checkTrajectory(item.trajectory, `${path}.trajectory`, owner);
    checkRotation(item.rotationModel, `${path}.rotationModel`, owner);
    checkGeometry(item.geometry, `${path}.geometry`, owner);
    checkFrameRef(item.trajectoryFrame, `${path}.trajectoryFrame`, owner);
    if (isObject(item.trajectoryPlot)) {
      checkKeys(item.trajectoryPlot, TRAJECTORY_PLOT_KEYS, `${path}.trajectoryPlot`, `trajectoryPlot of ${owner}`, 'trajectoryPlot');
    }
    if (isObject(item.label)) {
      checkKeys(item.label, LABEL_KEYS, `${path}.label`, `label of ${owner}`, 'label');
    }
    if (Array.isArray(item.arcs)) item.arcs.forEach((a, i) => checkArc(a, `${path}.arcs[${i}]`, owner, i));
    if (Array.isArray(item.items)) item.items.forEach((c, i) => checkItem(c, `${path}.items[${i}]`));
  };

  checkKeys(json, CATALOG_KEYS, '$', 'the catalog', 'catalog');
  if (Array.isArray(json.items)) json.items.forEach((item, i) => checkItem(item, `$.items[${i}]`));
  if (Array.isArray(json.frames)) {
    json.frames.forEach((f, i) => {
      if (isObject(f)) checkKeys(f, FRAME_SPEC_KEYS, `$.frames[${i}]`, `declared frame ${i}`, 'frames');
    });
  }
  if (Array.isArray(json.spkImport)) {
    json.spkImport.forEach((s, i) => {
      if (!isObject(s)) return;
      checkKeys(s, SPK_IMPORT_KEYS, `$.spkImport[${i}]`, `spkImport ${i}`, 'spkImport');
      // `defaults` is a partial item, checked as one (a name is supplied per import).
      if (isObject(s.defaults)) checkItem({ name: `spkImport ${i} defaults`, ...s.defaults }, `$.spkImport[${i}].defaults`);
    });
  }
  return out;
}

/** The fix to suggest for `key`: a known alias first, then a near spelling
 *  among the valid keys, then the same key in a node it plausibly belongs in. */
function suggest(key: string, allowed: KeySet, aliasKind: string, siblings: Array<[string, KeySet]>): Fix | undefined {
  const alias = KNOWN_ALIASES[aliasKind]?.[key];
  if (alias) return alias;
  const near = nearest(key, [...allowed]);
  if (near) return { key: near };
  for (const [where, siblingKeys] of siblings) {
    if (siblingKeys.has(key)) return { key, where: `in ${where}` };
  }
  return undefined;
}

/** The closest candidate by case-insensitive edit distance, if it is close
 *  enough to be the same word misspelled: at most 2 edits, or a third of the
 *  word for longer keys. A case-only difference always qualifies. */
function nearest(word: string, candidates: readonly string[]): string | undefined {
  const w = word.toLowerCase();
  const limit = Math.max(2, Math.floor(word.length / 3));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(w, c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}
