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
      // Exact attached-file size from the archived original label, not rounded ODE kilobytes.
      const bytes = Number(field(lines, 'RECORD_BYTES')) * Number(field(lines, 'FILE_RECORDS'));
      if (Number.isSafeInteger(bytes) && bytes > 0) d.asset.bytes = bytes;
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
    }
    if (row.iid === 'HIRISE') {
      m.sourceProjection = 'EQUIRECTANGULAR (archive index record)'; d.projection = m.sourceProjection;
      m.bands = record.kind === 'stereo-dtm' ? ['height; datum unverified'] : ['HiRISE RED'];
      if (record.kind === 'stereo-dtm') {
        const id = region === 'jezero' ? 'ESP_023524_1985_RED_C_01_ORTHO' : 'ESP_016520_1750_RED_C_01_ORTHO';
        const raster = m.assets.find(a => a.url.endsWith('/' + id + '.JP2'));
        const label = m.assets.find(a => a.url.endsWith('/' + id + '.LBL'));
        if (!raster || !label) throw new Error('Released matching ortho is absent from primary asset listing');
        const image = structuredClone(record);
        image.kind = 'orthoimage'; image.descriptor.id = 'ode:' + id + '@01'; image.descriptor.productId = id;
        image.descriptor.channel = 'imagery'; image.descriptor.nativeGsdM = null;
        delete image.descriptor.footprint; image.evidence.footprint = 'unknown'; delete image.evidence.footprintUrl;
        image.descriptor.asset = { url: raster.url, bytes: raster.bytes, version: '01' };
        const im = image.descriptor.metadata;
        im.labelUrl = label.url; im.rasterGsdM = null; im.bands = ['HiRISE RED ortho']; im.stereoProductIds = [d.productId];
        im.observationId = id.replace('_RED_C_01_ORTHO', ''); im.assets = [raster, label];
        im.registration = { group: d.productId, evidenceUrl: url, accuracyM: null };
        m.registration = { group: d.productId, evidenceUrl: url, accuracyM: null };
        im.sourceProjection = null; image.descriptor.projection = 'Unknown until ortho label accessible';
        im.unknowns.push('Ortho label unreachable during metadata smoke; no DTM footprint or scale copied to image');
        image.evidence.caveats = [...im.unknowns, 'Existence established independently by released DTM Product_files; label URL preserved'];
        inventory.push(image);
        m.stereoProductIds = [id];
        // The DTM asset list also contains ortho files; downloading this source means its own DTM raster only.
        m.assets = m.assets.filter(a => !/_ORTHO\./.test(a.url));
      }
    }
    inventory.push(record);
  }
  for (const image of inventory.filter(r => r.kind === 'observation-image' && r.descriptor.metadata.observationId)) {
    const matching = inventory.filter(r => r.kind === 'orthoimage' && r.descriptor.metadata.observationId === image.descriptor.metadata.observationId);
    image.descriptor.metadata.stereoProductIds = [...new Set(matching.flatMap(r => r.descriptor.metadata.stereoProductIds))];
  }
  inventory.sort((a, b) => a.descriptor.id < b.descriptor.id ? -1 : 1);
  await writeFile(new URL(`mars-${region}.inventory.json`, root), JSON.stringify(inventory, null, 2) + '\n');
}
