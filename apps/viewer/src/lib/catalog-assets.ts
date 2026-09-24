/**
 * Catalog-relative asset paths.
 *
 * A catalog's relative paths belong to the catalog, not the page showing it.
 * `loadCatalogFromUrl` already resolves `require` and `spiceKernels` against
 * each catalog's own URL, and so does Cosmographia's loader. The renderer,
 * though, only sees bare JSON: its resolvers get a path string and nothing
 * about which catalog it came from. Left relative, a remote or nested catalog's
 * `"../models/spacecraft.glb"` would load against the viewer page.
 *
 * So URL-loaded catalogs have their asset fields made absolute here, against
 * the catalog they came from, before the scene is built. Drag-dropped catalogs
 * don't pass through this: they have no URL, and their assets resolve through
 * the dropped-file maps instead.
 */

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Resolve `ref` against the URL of the catalog that contains it.
 *
 * Not `new URL(ref, base)`: that percent-encodes the reference, and asset
 * fields carry templates (`{z}/{y}/{x}` imagery URLs, `%level` tile names)
 * that the loaders substitute later. The reference is joined as written; only
 * `.` and `..` segments are collapsed, within the base's own path.
 */
export function resolveCatalogRelative(ref: string, catalogUrl: string): string {
  if (ref === '' || SCHEME.test(ref)) return ref;
  const base = new URL(catalogUrl);
  if (ref.startsWith('//')) return `${base.protocol}${ref}`;
  // `protocol//host` rather than `origin`, which is "null" for file: URLs.
  const root = `${base.protocol}//${base.host}`;
  if (ref.startsWith('/')) return `${root}${ref}`;

  // Only the path part of the reference is normalized; a `?` or `#` suffix,
  // and any template characters in either, pass through untouched.
  const cut = ref.search(/[?#]/);
  const refPath = cut < 0 ? ref : ref.slice(0, cut);
  const suffix = cut < 0 ? '' : ref.slice(cut);

  const segments = base.pathname.split('/').slice(0, -1); // the catalog's directory
  const parts = refPath.split('/');
  parts.forEach((seg, i) => {
    const last = i === parts.length - 1;
    if (seg === '.' || (seg === '' && !last)) {
      if (last) segments.push('');
    } else if (seg === '..') {
      if (segments.length > 1) segments.pop();
      if (last) segments.push('');
    } else {
      segments.push(seg);
    }
  });
  return `${root}${segments.join('/')}${suffix}`;
}

/** Globe fields that hold a texture path. */
const GLOBE_TEXTURE_FIELDS = ['normalMap', 'displacementMap', 'bumpMap'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Rewrite a catalog's asset paths as absolute URLs against `catalogUrl`, in
 * place. The fields are the ones the renderer loads: a Mesh's or Dsk's `source`, a
 * Globe's texture maps and tile templates, its terrain and imagery endpoints
 * and surface tilesets, and a ring system's `texture`.
 *
 * Trajectory and rotation `source`s are not touched. The viewer pre-fetches
 * those itself, keyed by the path as written (see `fetchCatalogDataFiles`).
 */
export function absolutizeCatalogAssets(catalog: unknown, catalogUrl: string): void {
  const fix = (obj: Obj, key: string) => {
    const v = obj[key];
    if (typeof v === 'string') obj[key] = resolveCatalogRelative(v, catalogUrl);
  };
  const fixUrls = (v: unknown) => {
    for (const entry of Array.isArray(v) ? v : [v]) if (isObj(entry)) fix(entry, 'url');
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isObj(node)) return;

    switch (node.type) {
      case 'Mesh':
      case 'Dsk':
        fix(node, 'source');
        break;
      case 'Globe': {
        if (typeof node.baseMap === 'string') fix(node, 'baseMap');
        else if (isObj(node.baseMap)) {
          fix(node.baseMap, 'template');
          fix(node.baseMap, 'topLayer');
        }
        for (const f of GLOBE_TEXTURE_FIELDS) fix(node, f);
        if (isObj(node.terrain)) {
          fix(node.terrain, 'url');
          fix(node.terrain, 'normalMapUrl');
          fixUrls(node.terrain.imagery);
        }
        fixUrls(node.surfaceTiles);
        break;
      }
      case 'Rings':
        fix(node, 'texture');
        break;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(catalog);
}

/**
 * Whether any catalog in a scene draws a DSK surface. A DSK is read by SPICE,
 * so a scene with one needs an engine even when it furnishes no kernels at all.
 */
export function catalogsUseDsk(catalogs: readonly unknown[]): boolean {
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (!isObj(node)) return false;
    if (node.type === 'Dsk' && typeof node.source === 'string') return true;
    return Object.values(node).some(walk);
  };
  return catalogs.some(walk);
}
