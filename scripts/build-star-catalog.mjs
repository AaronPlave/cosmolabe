#!/usr/bin/env node
/**
 * Build a compact binary star catalog from the HYG database.
 *
 * Downloads naked-eye stars (mag < 6.5) from the datastro.eu HYG API,
 * converts RA/Dec (J2000 equatorial) to ECLIPJ2000 Cartesian unit vectors,
 * computes physically-based spectral colors via black body chromaticity,
 * and writes a compact binary file for the StarField renderer.
 *
 * Binary format v2 (little-endian):
 *   Header (16 bytes):
 *     4 bytes: magic "STR2"
 *     4 bytes: uint32 star count
 *     4 bytes: float32 brightest magnitude
 *     4 bytes: float32 faintest magnitude
 *   Per star (10 bytes):
 *     3× Int16: unit direction vector (normalized to ±0x7FFF)
 *     1× Uint8: magnitude (normalized 0=brightest, 255=faintest)
 *     3× Uint8: pre-baked linear sRGB color (black body chromaticity)
 *   Total: 16 + 10*N bytes (~89KB for ~8800 stars)
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

/**
 * B-V color index → effective temperature (Ballesteros 2012).
 */
function bvToTemperature(bv) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/**
 * Effective temperature → linear sRGB unit chromaticity.
 * Pipeline: temperature → CIE 1960 UCS → CIE 1931 xy → XYZ → linear sRGB.
 * Normalized so max component = 1 (pure chromaticity, no luminance).
 * Reference: https://google.github.io/filament/Filament.html
 */
function temperatureToRGB(T) {
  const T2 = T * T;

  // CIE 1960 UCS chromaticity (Filament black body model)
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T2) /
            (1 + 8.42420235e-4 * T + 7.08145163e-7 * T2);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T2) /
            (1 - 2.89741816e-5 * T + 1.61456053e-7 * T2);

  // CIE 1960 UCS → CIE 1931 xy
  const denom = 2 * u - 8 * v + 4;
  const x = (3 * u) / denom;
  const y = (2 * v) / denom;

  // CIE xy → XYZ (Y = 1)
  const Y = 1;
  const X = y > 0 ? (x * Y) / y : 0;
  const Z = y > 0 ? ((1 - x - y) * Y) / y : 0;

  // XYZ → linear sRGB (sRGB primaries, D65 white point)
  let r =  3.2406255 * X - 1.5372080 * Y - 0.4986286 * Z;
  let g = -0.9689307 * X + 1.8757561 * Y + 0.0415175 * Z;
  let b =  0.0557101 * X - 0.2040211 * Y + 1.0569959 * Z;

  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);

  // Normalize to unit chromaticity (max component = 1)
  const maxC = Math.max(r, g, b);
  if (maxC > 0) return [r / maxC, g / maxC, b / maxC];
  return [1, 1, 1];
}

/**
 * B-V color index → linear sRGB unit chromaticity via black body radiation.
 */
function bvToRGB(bv) {
  return temperatureToRGB(bvToTemperature(bv));
}

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
    if (mag < -10) continue; // Skip the Sun and any other extreme outliers

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

    // Compute physically-based spectral color from B-V index
    const [r, g, b] = bvToRGB(isNaN(bv) ? 0.65 : bv);
    stars.push({ x, y, z, mag, r, g, b });
  }

  // Sort by magnitude (brightest first)
  stars.sort((a, b) => a.mag - b.mag);

  const magBright = stars[0].mag;
  const magFaint = stars[stars.length - 1].mag;
  const magRange = magFaint - magBright;

  console.log(`Parsed ${stars.length} stars (mag ${magBright.toFixed(2)} to ${magFaint.toFixed(2)})`);

  // Write compact binary v2: header (16 bytes) + 10 bytes per star
  const HEADER_SIZE = 16;
  const BYTES_PER_STAR = 10;
  const buffer = Buffer.alloc(HEADER_SIZE + stars.length * BYTES_PER_STAR);

  // Header
  buffer.write('STR2', 0, 'ascii');
  buffer.writeUInt32LE(stars.length, 4);
  buffer.writeFloatLE(magBright, 8);
  buffer.writeFloatLE(magFaint, 12);

  for (let i = 0; i < stars.length; i++) {
    const off = HEADER_SIZE + i * BYTES_PER_STAR;
    const s = stars[i];

    // Position: unit vector as Int16 (normalized to ±0x7FFF, ~0.002° angular error)
    buffer.writeInt16LE(Math.round(s.x * 0x7FFF), off);
    buffer.writeInt16LE(Math.round(s.y * 0x7FFF), off + 2);
    buffer.writeInt16LE(Math.round(s.z * 0x7FFF), off + 4);

    // Magnitude: normalized to [0, 255] within range (0=brightest, 255=faintest)
    const magNorm = magRange > 0 ? (s.mag - magBright) / magRange : 0;
    buffer.writeUInt8(Math.round(magNorm * 255), off + 6);

    // Color: pre-baked black body chromaticity as linear sRGB (0-255)
    buffer.writeUInt8(Math.round(s.r * 255), off + 7);
    buffer.writeUInt8(Math.round(s.g * 255), off + 8);
    buffer.writeUInt8(Math.round(s.b * 255), off + 9);
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
