#!/usr/bin/env node
// Deterministic, metadata-only replay of curated primary archive captures. Never fetches.
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeOdeMarsProduct, odeMarsRows } from './ode-mars-metadata.mjs';
const root = new URL('../docs/examples/surface-plans/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL('evidence/' + name, root), 'utf8'));
const manifest = await read('manifest.json');
const capture = async name => {
  const entry = manifest.entries.find(e => e.file === name);
  return { rows: odeMarsRows(await read(name)), url: entry.metadataUrl };
};
const field = (lines, name) => lines.filter(l => l.trim().startsWith(name + ' ') || l.trim().startsWith(name + '=')).at(-1)?.split('=').slice(1).join('=').trim().replace(/^"|"$/g, '') ?? null;
const numberField = (lines, name) => Number.parseFloat(field(lines, name));
function labelMetadata(d, lines) {
  const m = d.metadata;
  if (!lines.length) return;
  m.confidence = 'label';
  m.dataType = [field(lines, 'SAMPLE_TYPE'), field(lines, 'SAMPLE_BITS')].filter(Boolean).join(' / ') || null;
  const radius = numberField(lines, 'A_AXIS_RADIUS');
  if (Number.isFinite(radius)) m.sourceCoordinates = `Planetocentric, positive east; local projection sphere radius ${radius} km (label), derived from Mars 3396.19/3376.2 km ellipsoid`;
  for (const key of ['DATA_QUALITY_DESC', 'MISSING_CONSTANT', 'CORE_NULL', 'CORE_LOW_REPR_SATURATION', 'CORE_HIGH_REPR_SATURATION']) {
    const value = field(lines, key);
    if (value !== null) m.unknowns.push(`Original label ${key}=${value}; no per-pixel mask audit`);
  }
  const scale = field(lines, 'SCALING_FACTOR'), offset = field(lines, 'OFFSET');
  if (d.channel === 'imagery' && scale !== null && offset !== null) {
    m.illumination ??= { incidenceDeg: null, emissionDeg: null, phaseDeg: null, photometry: null };
    m.illumination.photometry = `Label I/F = DN * ${scale} + ${offset}; no cross-observation photometric normalization inferred`;
  }
}
for (const region of ['jezero', 'gale']) {
  const inventory = [];
  for (const file of [`viking-${region}.json`, region === 'jezero' ? 'mola-jezero-tile.json' : 'mola-gale128.json',
    `${region}-ctx.json`, `${region}-hrsc.json`, `${region}-hirise.json`, `${region}-dtm-ode.json`]) {
    const { rows, url } = await capture(file);
    const row = rows[0], record = normalizeOdeMarsProduct(row, url);
    if (!record) throw new Error('Unsupported curated product: ' + file);
    const d = record.descriptor, m = d.metadata, lines = Array.isArray(row.label?.Line) ? row.label.Line : [];
    const projection = field(lines, 'MAP_PROJECTION_TYPE');
    if (projection) { m.sourceProjection = projection; d.projection = projection + ' (source label; footprint separately normalized by ODE)'; }
    m.dataType = field(lines, 'SAMPLE_TYPE');
    const bands = field(lines, 'BANDS'); m.bands = bands === '1' ? ['single band (see label for physical meaning)'] : null;
    labelMetadata(d, lines);
    // Fixed-record attached-file bytes apply to these products; JP2 labels describe
    // uncompressed storage instead and must not set compressed download cost.
    if (row.iid !== 'HIRISE' || record.kind === 'stereo-dtm') {
      const bytes = numberField(lines, 'RECORD_BYTES') * numberField(lines, 'FILE_RECORDS');
      if (Number.isSafeInteger(bytes) && bytes > 0) {
        d.asset.bytes = bytes;
        const asset = m.assets.find(a => a.url === d.asset.url);
        if (asset) { asset.bytes = bytes; asset.sizeEvidence = 'Original attached label RECORD_BYTES * FILE_RECORDS'; }
      }
    }
    if (row.iid === 'MOLA') {
      const text = await readFile(new URL(`evidence/mola-${region}-label.xml`, root), 'utf8');
      const gsd = Number(/<cart:pixel_resolution_x[^>]*>([^<]+)/.exec(text)?.[1]) * 1000;
      m.confidence = 'label'; m.rasterGsdM = gsd; d.nativeGsdM = gsd;
      m.dataType = 'SignedMSB2'; m.bands = ['topography (planetary radius minus areoid radius), metres'];
      m.sourceProjection = 'Equirectangular'; d.projection = 'Equirectangular (3396 km reference sphere)';
      m.sourceDatum = 'GMM-3 areoid; radial height (PDS4 label)';
      m.sourceCoordinates = 'Planetocentric, positive east, 3396 km reference sphere';
      d.datum = { referenceShape: { kind: 'sphere', radiusKm: 3396 }, verticalDatum: 'areoid', heightConvention: 'radial' };
      d.nodata = 'unknown'; // Label describes interpolated empty bins; no independent per-pixel validity audit.
      m.unknowns = ['Valid-pixel mask not audited', 'Native shot spacing/coverage differs from gridded source sampling', 'Accuracy and areoid-to-target transform unresolved'];
      record.evidence.caveats = ['PDS4: bins without observations are interpolated; equatorial shot occupancy about 55%, profile gaps up to 12 km', ...m.unknowns];
    }
    if (row.iid === 'HRSC') {
      m.sourceDatum = 'HEIGHT_ABOVE_SPHEROID; 3396 km sphere, from MEX:DTM label group';
      m.sourceCoordinates = 'Planetocentric, positive east, 3396 km sphere';
      d.datum = { referenceShape: { kind: 'sphere', radiusKm: 3396 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };
      m.confidence = 'label'; m.bands = ['height above spheroid, metres'];
      record.evidence.caveats.push('MEX:DTM_MISSING_DN=-32768; footprint is not a valid-data mask');
    }
    if (row.iid === 'VISAB') {
      m.sourceCoordinates = 'Original label: positive west, ellipsoid; ODE footprint is planetocentric east';
      m.sourceDatum = 'Original label axes must be retained for any raster reprojection; target transform unverified';
      record.evidence.caveats.push('Viking MDIM is a controlled regional baseline tile; no uniform native acquisition resolution or photometric consistency is claimed');
    }
    if (row.iid === 'CTX') {
      m.sourceProjection = 'Unprojected EDR'; d.projection = 'Unprojected EDR; camera model/orthorectification required';
      m.bands = ['CTX panchromatic']; m.observationId = row.pdsid;
      record.evidence.caveats.push('CTX EDR is not an orthophoto; no automatic fusion or released DTM inferred');
      const quality = field(lines, 'DATA_QUALITY_DESC');
      if (quality) record.evidence.caveats.push(`Original CTX label DATA_QUALITY_DESC=${quality}; consult label before source selection`);
    }
    if (row.iid === 'HIRISE') {
      m.sourceProjection = 'EQUIRECTANGULAR (original label)'; d.projection = m.sourceProjection;
      m.bands = record.kind === 'stereo-dtm' ? ['height in metres above Mars 2000 equipotential surface (Smith et al. 2001)'] : ['HiRISE RED'];
      if (record.kind === 'stereo-dtm') {
        m.sourceDatum = 'Mars 2000 equipotential surface (Smith et al. 2001), original IMAGE NOTE; target height transform unresolved';
        d.datum.verticalDatum = 'areoid';
        m.unknowns = m.unknowns.filter(s => s !== 'Source datum requires original label verification');
        record.evidence.caveats = record.evidence.caveats.filter(s => s !== 'Source datum requires original label verification');
        const id = region === 'jezero' ? 'ESP_023524_1985_RED_C_01_ORTHO' : 'ESP_016520_1750_RED_C_01_ORTHO';
        const raster = m.assets.find(a => a.url.endsWith('/' + id + '.JP2'));
        const label = m.assets.find(a => a.url.endsWith('/' + id + '.LBL'));
        if (!raster || !label) throw new Error('Released matching ortho is absent from primary asset listing');
        const image = structuredClone(record);
        image.kind = 'orthoimage'; image.descriptor.id = 'ode:' + id + '@01'; image.descriptor.productId = id;
        image.descriptor.channel = 'imagery';
        image.descriptor.asset = { url: raster.url, bytes: raster.bytes, version: '01' };
        const im = image.descriptor.metadata;
        const orthoLines = (await readFile(new URL(`evidence/${region}-ortho.lbl`, root), 'utf8')).split('\n');
        if (field(orthoLines, 'PRODUCT_ID') !== id || !orthoLines.join('\n').includes(d.productId)) throw new Error('Ortho label identity/stereo relationship mismatch');
        im.labelUrl = label.url; im.rasterGsdM = numberField(orthoLines, 'MAP_SCALE'); image.descriptor.nativeGsdM = im.rasterGsdM;
        im.sourceProjection = field(orthoLines, 'MAP_PROJECTION_TYPE'); image.descriptor.projection = im.sourceProjection + ' (original ortho label)';
        im.bands = ['HiRISE RED ortho']; im.stereoProductIds = [d.productId];
        // Its own label supplies an envelope, not the DTM footprint and not valid pixels.
        const west = numberField(orthoLines, 'WESTERNMOST_LONGITUDE'), east = numberField(orthoLines, 'EASTERNMOST_LONGITUDE');
        const south = numberField(orthoLines, 'MINIMUM_LATITUDE'), north = numberField(orthoLines, 'MAXIMUM_LATITUDE');
        if (![west, east, south, north, im.rasterGsdM].every(Number.isFinite)) throw new Error('Incomplete ortho label');
        image.descriptor.footprint = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'label-envelope', properties: null,
          geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } }] };
        image.evidence.footprint = 'raster-envelope'; image.evidence.footprintUrl = label.url;
        im.observationId = id.replace('_RED_C_01_ORTHO', ''); im.assets = [raster, label];
        im.registration = { group: d.productId, evidenceUrl: url, accuracyM: null };
        m.registration = { group: d.productId, evidenceUrl: url, accuracyM: null };
        im.sourceDatum = 'Image orthorectified with the separately released DTM; target registration/height transform unresolved';
        im.unknowns = ['Valid-pixel mask unverified', 'Physical accuracy unverified', 'Cross-product registration accuracy and target transform unresolved'];
        labelMetadata(image.descriptor, orthoLines);
        image.evidence.caveats = [...im.unknowns, 'Existence and DTM relationship established by original ortho label SOURCE_PRODUCT_ID; envelope is not valid pixels'];
        inventory.push(image);
        m.stereoProductIds = [id];
        // The DTM asset list also contains ortho files; downloading this source means its own DTM raster only.
        m.assets = m.assets.filter(a => !/_ORTHO\./.test(a.url));
      }
    }
    record.evidence.caveats = [...new Set([...record.evidence.caveats, ...m.unknowns])];
    inventory.push(record);
  }
  for (const image of inventory.filter(r => r.kind === 'observation-image' && r.descriptor.metadata.observationId)) {
    const matching = inventory.filter(r => r.kind === 'orthoimage' && r.descriptor.metadata.observationId === image.descriptor.metadata.observationId);
    image.descriptor.metadata.stereoProductIds = [...new Set(matching.flatMap(r => r.descriptor.metadata.stereoProductIds))];
  }
  inventory.sort((a, b) => a.descriptor.id < b.descriptor.id ? -1 : 1);
  await writeFile(new URL(`mars-${region}.inventory.json`, root), JSON.stringify(inventory, null, 2) + '\n');
}
