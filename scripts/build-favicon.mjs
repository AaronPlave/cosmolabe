#!/usr/bin/env node
/** Build the temporary viewer favicon set from the 180px planet artwork. */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const ART = new URL('../apps/viewer/public/apple-touch-icon.png', import.meta.url);
const PUBLIC = new URL('../apps/viewer/public/', import.meta.url);
const source = PNG.sync.read(readFileSync(ART));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mix = (a, b, t) => a + (b - a) * t;

// The source is a sphere against a dark background. The favicon tile is darker
// so the unlit hemisphere remains legible without adding a second circular rim.
const tileColor = [4, 10, 18];
const borderColor = [51, 72, 94];
const planetNightSide = [8, 17, 29];
const sourceBackground = [13, 25, 37];
const sourceCenter = [98, 95];
const sourceRadius = 73.5;
const samplesPerPixel = 4;

function render(size) {
  const output = new PNG({ width: size, height: size });
  const halfTile = size * 0.46875; // 30 px at 32; 15 px at 16.
  const cornerRadius = size * 0.1875; // 6 px at 32; 3 px at 16.
  const planetRadius = size * 0.365625; // About 78% of the tile width.

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < samplesPerPixel; sy++) {
        for (let sx = 0; sx < samplesPerPixel; sx++) {
          const px = x + (sx + 0.5) / samplesPerPixel;
          const py = y + (sy + 0.5) / samplesPerPixel;
          const dx = Math.abs(px - size / 2);
          const dy = Math.abs(py - size / 2);
          const qx = dx - (halfTile - cornerRadius);
          const qy = dy - (halfTile - cornerRadius);
          const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
            + Math.min(Math.max(qx, qy), 0) - cornerRadius;
          const tileCoverage = clamp(0.5 - distance, 0, 1);
          if (!tileCoverage) continue;

          let color = tileColor;
          if (distance > -1 && distance < 0) {
            const edge = clamp(distance + 1, 0, 1);
            color = tileColor.map((channel, i) => mix(borderColor[i], channel, edge));
          }

          const planetX = px - size / 2;
          const planetY = py - size / 2;
          const planetDistance = Math.hypot(planetX, planetY);
          const planetCoverage = clamp(planetRadius + 0.5 - planetDistance, 0, 1);
          if (planetCoverage) {
            const imageX = sourceCenter[0] + planetX / planetRadius * sourceRadius;
            const imageY = sourceCenter[1] + planetY / planetRadius * sourceRadius;
            const x0 = clamp(Math.floor(imageX), 0, source.width - 1);
            const y0 = clamp(Math.floor(imageY), 0, source.height - 1);
            const x1 = Math.min(x0 + 1, source.width - 1);
            const y1 = Math.min(y0 + 1, source.height - 1);
            const fx = clamp(imageX - x0, 0, 1);
            const fy = clamp(imageY - y0, 0, 1);
            const planetColor = [];
            for (let channel = 0; channel < 3; channel++) {
              const a = source.data[(y0 * source.width + x0) * 4 + channel];
              const b = source.data[(y0 * source.width + x1) * 4 + channel];
              const c = source.data[(y1 * source.width + x0) * 4 + channel];
              const d = source.data[(y1 * source.width + x1) * 4 + channel];
              planetColor[channel] = (a * (1 - fx) + b * fx) * (1 - fy)
                + (c * (1 - fx) + d * fx) * fy;
            }
            // Treat the source's dark field as transparent to the tile. Keep
            // only its bright limb, which removes the source's marble-like
            // circular outline while retaining the partially lit planet.
            const luminance = planetColor[0] * 0.2126 + planetColor[1] * 0.7152 + planetColor[2] * 0.0722;
            const backgroundLuminance = sourceBackground[0] * 0.2126
              + sourceBackground[1] * 0.7152 + sourceBackground[2] * 0.0722;
            const light = clamp((luminance - backgroundLuminance - 8) / 42, 0, 1);
            const litPlanet = planetNightSide.map((channel, i) =>
              clamp(channel + Math.max(0, planetColor[i] - sourceBackground[i]) * light, 0, 255));
            color = color.map((channel, i) => mix(channel, litPlanet[i], planetCoverage));
          }

          red += color[0] * tileCoverage;
          green += color[1] * tileCoverage;
          blue += color[2] * tileCoverage;
          alpha += tileCoverage * 255;
        }
      }

      const i = (y * size + x) * 4;
      if (alpha) {
        const coverage = alpha / (samplesPerPixel * samplesPerPixel * 255);
        output.data[i] = Math.round(red / (samplesPerPixel * samplesPerPixel * coverage));
        output.data[i + 1] = Math.round(green / (samplesPerPixel * samplesPerPixel * coverage));
        output.data[i + 2] = Math.round(blue / (samplesPerPixel * samplesPerPixel * coverage));
        output.data[i + 3] = Math.round(coverage * 255);
      }
    }
  }
  return PNG.sync.write(output);
}

const sizes = [16, 32, 64];
const images = sizes.map(render);
for (let i = 0; i < sizes.length; i++) {
  writeFileSync(new URL(`favicon-${sizes[i]}.png`, PUBLIC), images[i]);
}

// ICO image directory embeds the same known-good PNG family, so browser and
// legacy clients cannot select a stale or visually different raster.
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i];
  header[entry + 1] = sizes[i];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
writeFileSync(new URL('favicon.ico', PUBLIC), Buffer.concat([header, ...images]));
console.log('Wrote transparent 16, 32 and 64px rounded-square favicons and matching ICO.');
