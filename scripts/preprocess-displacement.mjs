#!/usr/bin/env node
/**
 * Preprocess a displacement/heightmap texture for efficient browser loading.
 *
 * Produces two outputs from a single high-resolution grayscale heightmap:
 *   1. A downscaled displacement map (default 2K) — vertex displacement only needs
 *      as many pixels as there are mesh vertices (~200K for a 512×384 sphere).
 *   2. A full-resolution normal map — pre-baked Sobel-derived tangent-space normals
 *      so the browser doesn't have to do per-pixel canvas computation at load time.
 *
 * Usage:
 *   node scripts/preprocess-displacement.mjs <input> [options]
 *
 * Options:
 *   --outdir <dir>        Output directory (default: same as input)
 *   --disp-size <px>      Displacement map width in pixels (default: 2048)
 *   --normal-size <px>    Normal map width — 0 means same as input (default: 0)
 *   --strength <n>        Normal map strength / steepness (default: 3)
 *   --quality <n>         JPEG quality 1-100 (default: 90)
 *
 * Examples:
 *   node scripts/preprocess-displacement.mjs textures/moon-displacement-16k.jpg
 *   node scripts/preprocess-displacement.mjs textures/moon-displacement-16k.jpg --disp-size 2048 --strength 4
 */

import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';

// ── CLI args ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: '',
    outdir: '',
    dispSize: 2048,
    normalSize: 0, // 0 = same as input
    strength: 3,
    quality: 90,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--outdir':    opts.outdir = args[++i]; break;
      case '--disp-size': opts.dispSize = parseInt(args[++i], 10); break;
      case '--normal-size': opts.normalSize = parseInt(args[++i], 10); break;
      case '--strength':  opts.strength = parseFloat(args[++i]); break;
      case '--quality':   opts.quality = parseInt(args[++i], 10); break;
      default:
        if (!args[i].startsWith('--')) opts.input = args[i];
        else { console.error(`Unknown option: ${args[i]}`); process.exit(1); }
    }
  }

  if (!opts.input) {
    console.error('Usage: node scripts/preprocess-displacement.mjs <input> [options]');
    process.exit(1);
  }

  opts.input = resolve(opts.input);
  if (!existsSync(opts.input)) {
    console.error(`Input file not found: ${opts.input}`);
    process.exit(1);
  }
  if (!opts.outdir) opts.outdir = dirname(opts.input);

  return opts;
}

// ── Normal map generation ──────────────────────────────────────────────────────

/**
 * Generate a tangent-space normal map from grayscale height data.
 * Same Sobel algorithm as BodyMesh.generateNormalMapFromHeight but runs
 * on raw pixel buffers in Node instead of a browser canvas.
 */
function generateNormalMap(heightData, width, height, strength) {
  const out = Buffer.alloc(width * height * 3); // RGB

  // Sample height at (x, y) — wraps horizontally (equirectangular), clamps vertically
  const getH = (x, y) => {
    x = ((x % width) + width) % width;
    y = Math.max(0, Math.min(height - 1, y));
    return heightData[y * width + x] / 255;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const hL = getH(x - 1, y);
      const hR = getH(x + 1, y);
      const hU = getH(x, y - 1);
      const hD = getH(x, y + 1);

      const dx = (hR - hL) * strength;
      const dy = (hD - hU) * strength;

      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const nx = -dx / len;
      const ny = -dy / len;
      const nz = 1 / len;

      const idx = (y * width + x) * 3;
      out[idx]     = Math.round((nx * 0.5 + 0.5) * 255);
      out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }

  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const ext = extname(opts.input);
  // Strip resolution suffixes (e.g. "-16k") and displacement/height labels to get a clean body name
  const stem = basename(opts.input, ext)
    .replace(/-displacement|-heightmap|-height/i, '')
    .replace(/-\d+k$/i, '');

  console.log(`Input:    ${opts.input}`);

  // Read source image metadata
  const meta = await sharp(opts.input).metadata();
  const srcW = meta.width;
  const srcH = meta.height;
  console.log(`Source:   ${srcW}×${srcH}`);

  // ── 1. Downscaled displacement map ────────────────────────────────────────
  const dispW = opts.dispSize;
  const dispH = Math.round(dispW / 2); // 2:1 equirectangular
  const dispName = `${stem}-displacement-${dispW < 1000 ? dispW : Math.round(dispW / 1024) + 'k'}${ext}`;
  const dispPath = join(opts.outdir, dispName);

  console.log(`\nGenerating displacement map: ${dispW}×${dispH} → ${dispName}`);
  await sharp(opts.input)
    .resize(dispW, dispH, { kernel: sharp.kernel.lanczos3 })
    .jpeg({ quality: opts.quality })
    .toFile(dispPath);
  console.log(`  ✓ Saved ${dispPath}`);

  // ── 2. Normal map from full-resolution (or specified size) source ─────────
  const normalW = opts.normalSize || srcW;
  const normalH = opts.normalSize ? Math.round(opts.normalSize / 2) : srcH;
  const normalSizeLabel = normalW < 1000 ? `${normalW}` : `${Math.round(normalW / 1024)}k`;
  const normalName = `${stem}-normal-${normalSizeLabel}${ext}`;
  const normalPath = join(opts.outdir, normalName);

  console.log(`\nGenerating normal map: ${normalW}×${normalH} (strength=${opts.strength}) → ${normalName}`);

  // Read grayscale height data at target resolution
  const heightBuf = await sharp(opts.input)
    .resize(normalW, normalH, { kernel: sharp.kernel.lanczos3 })
    .greyscale()
    .raw()
    .toBuffer();

  console.log(`  Read ${heightBuf.length} height samples`);

  const normalRGB = generateNormalMap(heightBuf, normalW, normalH, opts.strength);

  await sharp(normalRGB, { raw: { width: normalW, height: normalH, channels: 3 } })
    .jpeg({ quality: opts.quality })
    .toFile(normalPath);
  console.log(`  ✓ Saved ${normalPath}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const { size: dispBytes } = await import('node:fs').then(fs => fs.statSync(dispPath));
  const { size: normalBytes } = await import('node:fs').then(fs => fs.statSync(normalPath));
  const { size: srcBytes } = await import('node:fs').then(fs => fs.statSync(opts.input));

  console.log(`\n── Summary ──`);
  console.log(`  Original:      ${(srcBytes / 1024 / 1024).toFixed(1)} MB  (${srcW}×${srcH})`);
  console.log(`  Displacement:  ${(dispBytes / 1024 / 1024).toFixed(1)} MB  (${dispW}×${dispH})`);
  console.log(`  Normal map:    ${(normalBytes / 1024 / 1024).toFixed(1)} MB  (${normalW}×${normalH})`);
  console.log(`  Browser saves: no ${srcW}×${srcH} canvas computation at load time`);
  console.log(`\nUpdate your catalog JSON:`);
  console.log(`  "displacementMap": "textures/${dispName}",`);
  console.log(`  "normalMap": "textures/${normalName}",`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
