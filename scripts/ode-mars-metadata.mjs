// Opt-in ODE REST v2.1.5 metadata only. No viewer imports, raster reads or redirects.
// Contract: https://oderest.rsl.wustl.edu/ODE_REST_V2.1.5.pdf (sections 3.3, 3.3.1).
const ENDPOINT = 'https://oderest.rsl.wustl.edu/live2/';
const MAX_BYTES = 1024 * 1024;
const COORDINATES = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] } };
const array = v => v == null ? [] : Array.isArray(v) ? v : [v];
const string = v => typeof v === 'string' && v.trim() ? v.trim() : null;
const numeric = v => string(v) !== null && Number.isFinite(Number(v)) ? Number(v) : null;
const https = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };

/** Bounded polygon-only WKT reader; preserves holes and multipolygons, rejects unsupported geometry. */
export function odeFootprint(wkt) {
  if (typeof wkt !== 'string' || wkt.length > 150000) return null;
  const match = /^(POLYGON|MULTIPOLYGON)\s*(\(.*\))$/is.exec(wkt.trim());
  if (!match) return null;
  const tokens = match[2].match(/[(),]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  // Reject leftover characters and enforce vertex/resource bounds before parsing.
  if (match[2].replace(/[(),\s]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi, '') || tokens.length > 18000) return null;
  let index = 0, vertices = 0;
  const take = t => { if (tokens[index++] !== t) throw new Error('Invalid WKT'); };
  const group = item => {
    take('('); const list = [item()];
    while (tokens[index] === ',') { index++; list.push(item()); }
    take(')'); return list;
  };
  const point = () => {
    const x = Number(tokens[index++]), y = Number(tokens[index++]); vertices++;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 360 || y < -90 || y > 90 || vertices > 4096) throw new Error('Invalid coordinate');
    return [x, y];
  };
  const ring = () => { const r = group(point); if (r.length < 4 || r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1]) throw new Error('Open WKT ring'); return r; };
  try {
    const coordinates = match[1] === 'POLYGON' ? group(ring) : group(() => group(ring));
    if (index !== tokens.length) return null;
    return { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'ode-footprint', properties: { provenance: 'ODE archive footprint, not valid pixels' },
      geometry: { type: match[1] === 'POLYGON' ? 'Polygon' : 'MultiPolygon', coordinates } }] };
  } catch { return null; }
}
/** Require full mission/instrument/product tuple: ODE silently ignores spatial filters without it. */
export function odeMarsUrl(query, offset = 1, limit = 16) {
  if (!query || typeof query !== 'object') throw new Error('ODE search requires a query object');
  const allowed = ['mission', 'instrument', 'productType', 'productId', 'minLat', 'maxLat', 'westernLon', 'easternLon'];
  if (Object.keys(query).some(k => !allowed.includes(k))) throw new Error('Unknown ODE search field');
  for (const key of ['mission', 'instrument', 'productType']) if (!/^[\w-]{1,32}$/.test(query[key] ?? '')) throw new Error('ODE search requires mission/instrument/productType');
  const url = new URL(ENDPOINT), p = url.searchParams;
  Object.entries({ query: 'product', target: 'mars', results: 'copmf', output: 'json', offset, limit,
    ihid: query.mission, iid: query.instrument, pt: query.productType }).forEach(([k, v]) => p.set(k, String(v)));
  if (query.productId !== undefined) {
    if (!/^[\w.*:-]{1,200}$/.test(query.productId)) throw new Error('Invalid ODE product ID');
    p.set('productid', query.productId);
  }
  const keys = ['minLat', 'maxLat', 'westernLon', 'easternLon'];
  if (keys.some(k => query[k] !== undefined)) {
    if (!keys.every(k => Number.isFinite(query[k])) || query.minLat < -90 || query.maxLat > 90 || query.minLat > query.maxLat
      || query.westernLon < 0 || query.westernLon > 360 || query.easternLon < 0 || query.easternLon > 360) throw new Error('Invalid ODE bounds: use planetocentric latitude and east 0..360 longitude');
    keys.forEach(k => p.set(k.toLowerCase(), String(query[k])));
  } else if (!query.productId) throw new Error('Bound ODE search with a region or product ID');
  return url.href;
}
/** Normalize actual live2 field names into the same offline SurfaceDiscoveryRecord contract. */
export function normalizeOdeMarsProduct(v, evidenceUrl = ENDPOINT) {
  if (!v || typeof v !== 'object') return null;
  const productId = string(v.Product_lid) || string(v.pdsid);
  if (!productId || String(v.Target_name).toUpperCase() !== 'MARS') return null;
  const instrument = String(v.iid).toUpperCase(), pt = String(v.pt).toUpperCase();
  const kind = instrument === 'HIRISE' && pt === 'DTM' ? 'stereo-dtm'
    : instrument === 'HRSC' && pt === 'DTMRDR' && /_DT4\.IMG$/i.test(productId) ? 'gridded-elevation'
    : instrument === 'MOLA' && pt === 'MEGDR' && /^megt/i.test(v.pdsid ?? '') ? 'gridded-elevation'
    : instrument === 'VISAB' && ['MDIM', 'MDIMC'].includes(pt) ? 'controlled-mosaic'
    : (instrument === 'CTX' && pt === 'EDR') || (instrument === 'HIRISE' && pt === 'RDRV11') ? 'observation-image' : null;
  if (!kind) return null; // No guessed channels for unsupported product families or associated DTM inference.
  const elevation = ['stereo-dtm', 'gridded-elevation'].includes(kind);
  const files = array(v.Product_files?.Product_file);
  const ownFile = files.find(f => f.Type === 'Product' && !/LABEL/i.test(f.Description) && f.FileName?.replace(/\.[^.]+$/, '').toLowerCase() === String(v.pdsid).replace(/\.[^.]+$/, '').toLowerCase())
    ?? files.find(f => /PRODUCT DATA FILE/.test(f.Description ?? ''));
  const labelUrl = https(v.LabelURL);
  const assetUrl = https(ownFile?.URL);
  const scale = numeric(v.Map_scale), rasterGsdM = instrument !== 'MOLA' && scale > 0 ? scale : null;
  // Native/source raster sampling, never a physical accuracy estimate or a promise of detector-native detail.
  const nativeGsdM = ['CTX', 'HIRISE', 'HRSC'].includes(instrument) && scale > 0 ? scale : null;
  const footprint = odeFootprint(v.Footprint_geometry);
  const unknowns = ['Valid-pixel mask unverified', 'Physical accuracy unverified', 'Source datum requires original label verification',
    'Underlying observation resolution may vary; source raster sampling is not physical accuracy'];
  const metadata = { evidenceUrl, ...(labelUrl ? { labelUrl } : {}), confidence: 'archive', unknowns,
    rasterGsdM, dataType: null, bands: null, acquisitionUtc: string(v.UTC_start_time), observationId: string(v.Observation_id),
    sourceProjection: null, sourceCoordinates: 'ODE footprint: planetocentric, east longitude 0..360; source raster conventions unverified',
    sourceDatum: null, registration: null,
    illumination: { incidenceDeg: numeric(v.Incidence_angle), emissionDeg: numeric(v.Emission_angle), phaseDeg: numeric(v.Phase_angle), photometry: null },
    stereoProductIds: [], assets: files.filter(f => f.Type === 'Product' && https(f.URL)).slice(0, 64).map(f => ({ url: https(f.URL),
      role: /LABEL/i.test(f.Description ?? '') ? 'label' : 'raster', bytes: numeric(f.KBytes) === null ? null : Math.ceil(Number(f.KBytes) * 1000),
      sizeEvidence: 'ODE KBytes (rounded decimal kilobytes, conservative estimate)' })), reuse: { status: 'unknown', evidenceUrl: null } };
  const bytes = numeric(ownFile?.KBytes);
  return { descriptor: { id: 'ode:' + productId + (string(v.Product_version_id) ? '@' + v.Product_version_id : ''), productId, channel: elevation ? 'elevation' : 'imagery', body: 'Mars', frame: 'IAU_MARS',
    coordinates: structuredClone(COORDINATES), ...(footprint ? { footprint } : {}), nodata: 'unknown', nativeGsdM, accuracyM: null,
    projection: 'Unconfirmed source projection; ODE geographic footprint is separately normalized',
    datum: { referenceShape: structuredClone(COORDINATES.referenceShape), verticalDatum: 'unknown', heightConvention: 'radial' },
    asset: { ...(assetUrl ? { url: assetUrl } : { retrieval: labelUrl ?? evidenceUrl }), ...(string(v.Product_version_id) ? { version: v.Product_version_id } : {}),
      ...(bytes !== null ? { bytes: Math.ceil(bytes * 1000) } : {}) },
    license: { name: 'Archive reuse terms unverified', attribution: [v.Producer_id, v.ihid, v.iid, v.Data_Set_Id].filter(Boolean).join(' / ') || 'PDS ODE' }, metadata },
  kind, evidence: { url: evidenceUrl, footprint: footprint ? 'archive-footprint' : 'unknown', ...(footprint ? { footprintUrl: evidenceUrl } : {}),
    caveats: [...unknowns, ...(array(v.ODE_notes?.ODE_note).filter(n => /ERROR|quality|missing|not found/i.test(n))) ] } };
}
export function odeMarsRows(payload) {
  const result = payload?.ODEResults;
  if (!result || typeof result !== 'object') throw new Error('Unrecognized ODE JSON envelope');
  if (result.Status !== 'Success') throw new Error('ODE service status: ' + result.Status + ' ' + JSON.stringify(result.Error ?? result.ErrorMessage ?? ''));
  return array(result.Products?.Product);
}
async function boundedJson(response) {
  if (!response.ok) throw new Error('ODE HTTP ' + response.status);
  const reader = response.body?.getReader(); if (!reader) throw new Error('ODE response body missing');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('ODE response exceeded 1 MiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(out));
}
/** Live smoke observed 1-based offsets (0 echoed as 1), despite manual's 0-based description. */
export async function fetchOdeMarsMetadata(query, { fetchImpl = fetch, pageSize = 16, maxPages = 2, timeoutMs = 12000 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 16 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('ODE limits: pageSize 1-16, maxPages 1-2, timeoutMs 100-30000');
  odeMarsUrl(query); // Fail invalid configuration before network access.
  const records = [], diagnostics = [], pages = [], ids = new Set();
  for (let page = 0; page < maxPages; page++) {
    const url = odeMarsUrl(query, 1 + page * pageSize, pageSize);
    let payload, rows;
    try {
      payload = await boundedJson(await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }));
      rows = odeMarsRows(payload);
    } catch (e) { diagnostics.push({ severity: 'warning', code: 'ode-unavailable', path: 'ode.page.' + (page + 1), message: String(e) }); break; }
    pages.push({ url, payload });
    let fresh = 0;
    for (const row of rows.slice(0, pageSize)) {
      const record = normalizeOdeMarsProduct(row, url);
      if (!record) { diagnostics.push({ severity: 'warning', code: 'ode-unsupported-product', path: 'ode', message: 'Unsupported product family or incomplete metadata: ' + (row?.pdsid ?? 'unknown') }); continue; }
      const key = record.descriptor.productId + '@' + (record.descriptor.asset.version ?? '');
      if (!ids.has(key)) { ids.add(key); records.push(record); fresh++; }
    }
    if (rows.length > pageSize) diagnostics.push({ severity: 'warning', code: 'ode-page-truncated', path: 'ode', message: 'Server exceeded requested page size' });
    if (rows.length < pageSize) break;
    if (fresh === 0) { diagnostics.push({ severity: 'warning', code: 'ode-repeated-page', path: 'ode', message: 'No new supported product identities; stop bounded search' }); break; }
    if (page + 1 === maxPages) diagnostics.push({ severity: 'warning', code: 'ode-page-cap', path: 'ode', message: 'Additional archive products may exist' });
  }
  return { version: 1, archive: 'PDS ODE Mars live2', records, diagnostics, pages,
    constraints: { pageSize, maxPages, noRasterDownload: true, footprintsUnverified: true } };
}
/** Replays the exact same adapter path. No alternate fixture schema or inferred quality. */
export async function replayOdeMarsMetadata(cache) {
  if (!Array.isArray(cache.pages) || cache.pages.length > 2) throw new Error('ODE cache must contain at most two pages');
  let page = 0;
  return fetchOdeMarsMetadata(cache.query, { pageSize: cache.pageSize, maxPages: cache.maxPages,
    fetchImpl: async url => {
      const entry = cache.pages[page++];
      if (!entry || entry.url !== url) throw new Error('ODE cache query/page mismatch');
      return new Response(JSON.stringify(entry.payload));
    } });
}
