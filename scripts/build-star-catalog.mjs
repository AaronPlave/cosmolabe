#!/usr/bin/env node
/**
 * Build a compact binary star catalog from the HYG database.
 *
 * Downloads naked-eye stars (mag < 6.5) from the datastro.eu HYG API,
 * converts RA/Dec (J2000 equatorial) to ECLIPJ2000 Cartesian unit vectors,
 * and writes a compact binary file for the StarField renderer.
 *
 * Binary format (little-endian):
 *   Header: 4 bytes magic "STAR", 4 bytes uint32 star count
 *   Per star (16 bytes): Float32 x, Float32 y, Float32 z, UInt8 mag*20, UInt8 (bv+0.5)*100, UInt16 unused/padding
 *   Total: 8 + 16*N bytes
 *
 * Actually using 12 bytes per star (3x Float32 position + 1x packed uint32 for mag+bv):
 *   Header: 8 bytes
 *   Per star: 3 Float32 (x,y,z) + 1 Float32 (packed: mag in low 16 bits as fixed-point, bv in high 16 bits)
 *   = 16 bytes per star
 *
 * Simplified: 5 Float32 per star (x, y, z, mag, bv) = 20 bytes per star
 *   Header: 8 bytes (magic + count)
 *   ~8800 stars × 20 bytes = ~176KB
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '../packages/three/src/data/stars.bin');

// Obliquity of ecliptic (J2000): 23.4392911 degrees
const OBLIQUITY = 23.4392911 * Math.PI / 180;
const COS_E = Math.cos(OBLIQUITY);
const SIN_E = Math.sin(OBLIQUITY);

const MAG_LIMIT = 6.5;
const API_URL = `https://www.datastro.eu/api/explore/v2.1/catalog/datasets/hyg-stellar-database/exports/csv?limit=-1&select=ra,dec,mag,ci&where=mag<${MAG_LIMIT}&order_by=mag`;

async function main() {
  console.log(`Fetching HYG stars with mag < ${MAG_LIMIT}...`);
  const resp = await fetch(API_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();

  const lines = text.trim().split('\n');
  const header = lines[0].replace(/^\uFEFF/, ''); // strip BOM
  const cols = header.split(';');
  const raIdx = cols.indexOf('ra');
  const decIdx = cols.indexOf('dec');
  const magIdx = cols.indexOf('mag');
  const ciIdx = cols.indexOf('ci');

  if (raIdx < 0 || decIdx < 0 || magIdx < 0) {
    throw new Error(`Missing columns. Header: ${header}`);
  }

  const stars = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(';');
    const raHours = parseFloat(fields[raIdx]);
    const decDeg = parseFloat(fields[decIdx]);
    const mag = parseFloat(fields[magIdx]);
    const bv = parseFloat(fields[ciIdx]);

    if (isNaN(raHours) || isNaN(decDeg) || isNaN(mag)) continue;

    // RA is in decimal hours → radians
    const ra = raHours * (Math.PI / 12);
    // Dec is in decimal degrees → radians
    const dec = decDeg * (Math.PI / 180);

    // J2000 equatorial → Cartesian
    const cosDec = Math.cos(dec);
    const xEq = cosDec * Math.cos(ra);
    const yEq = cosDec * Math.sin(ra);
    const zEq = Math.sin(dec);

    // Rotate to ecliptic J2000 (rotation around X by +obliquity)
    const x = xEq;
    const y = yEq * COS_E + zEq * SIN_E;
    const z = -yEq * SIN_E + zEq * COS_E;

    stars.push({ x, y, z, mag, bv: isNaN(bv) ? 0.65 : bv });
  }

  // Sort by magnitude (brightest first)
  stars.sort((a, b) => a.mag - b.mag);

  console.log(`Parsed ${stars.length} stars (brightest: mag ${stars[0].mag.toFixed(2)}, faintest: mag ${stars[stars.length - 1].mag.toFixed(2)})`);

  // Write binary: header (8 bytes) + 5 Float32 per star (20 bytes each)
  const HEADER_SIZE = 8;
  const FLOATS_PER_STAR = 5;
  const buffer = Buffer.alloc(HEADER_SIZE + stars.length * FLOATS_PER_STAR * 4);

  // Magic "STAR"
  buffer.write('STAR', 0, 'ascii');
  // Star count
  buffer.writeUInt32LE(stars.length, 4);

  for (let i = 0; i < stars.length; i++) {
    const off = HEADER_SIZE + i * FLOATS_PER_STAR * 4;
    buffer.writeFloatLE(stars[i].x, off);
    buffer.writeFloatLE(stars[i].y, off + 4);
    buffer.writeFloatLE(stars[i].z, off + 8);
    buffer.writeFloatLE(stars[i].mag, off + 12);
    buffer.writeFloatLE(stars[i].bv, off + 16);
  }

  // Write to both library data dir and viewer public dir
  const { mkdirSync } = await import('node:fs');
  const VIEWER_COPY = join(__dirname, '../apps/viewer/test-catalogs/stars.bin');

  for (const out of [OUTPUT, VIEWER_COPY]) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buffer);
    console.log(`Wrote ${stars.length} stars to ${out} (${(buffer.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
