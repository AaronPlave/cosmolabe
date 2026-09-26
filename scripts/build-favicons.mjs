#!/usr/bin/env node
/**
 * Build the derived viewer favicons in apps/viewer/src/assets/favicon/.
 *
 * Inputs (committed, hand-exported per size so tabs never show a
 * browser-downsampled image):
 *   favicon-16.png, favicon-32.png, favicon-64.png
 *   favicon.svg                      vector source for sizes with no export
 * Writes:
 *   favicon.ico                      16/32/64 PNG entries, copied byte-for-byte
 *   apple-touch-icon.png             180px rendered from the SVG on an opaque
 *                                    backdrop (iOS fills transparency with
 *                                    black, which swallows the unlit side)
 *
 * Usage: node scripts/build-favicons.mjs
 * Needs the viewer's `playwright` devDependency and a Chromium it can launch;
 * set CHROMIUM_PATH to use an existing browser binary instead of Playwright's.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', 'apps', 'viewer', 'src', 'assets', 'favicon');
const APPLE_TOUCH_BACKDROP = '#0b1624';

const svg = readFileSync(join(DIR, 'favicon.svg'), 'utf8');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();

async function render(size, background = 'transparent') {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:${background}">` +
      `<div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>` +
      `</body></html>`,
  );
  return page.screenshot({ omitBackground: background === 'transparent' });
}

// ICO with PNG-encoded images (supported by every browser that reads .ico).
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

writeFileSync(join(DIR, 'favicon.ico'), ico(
  [16, 32, 64].map((size) => ({ size, png: readFileSync(join(DIR, `favicon-${size}.png`)) })),
));
writeFileSync(join(DIR, 'apple-touch-icon.png'), await render(180, APPLE_TOUCH_BACKDROP));

await browser.close();
console.log(`favicons written to ${DIR}`);
