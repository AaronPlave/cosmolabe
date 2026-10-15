/** Publish the reviewed README clip and a responsive player to the configured data host. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createS3Storage } from './data-hosting/lib/storage.mjs';

const directory = resolve(process.argv[2] ?? resolve(tmpdir(), 'cosmolabe-readme-video'));
const basename = 'clipper-europa-flyby';
const caption = 'Europa Clipper passes Europa as Jupiter emerges behind the limb, then the camera pulls back to the system. Instrument fields of view come from IK kernels; pointing is illustrative and target-facing, without CK attitude coverage.';
const player = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cosmolabe — Europa Clipper flyby</title>
<style>body{margin:0;background:#080b10;color:#e2e8f0;font:16px/1.5 system-ui}main{max-width:1200px;margin:auto;padding:16px}video{display:block;width:100%;height:auto}a{color:#9ecbff}h1{font-size:22px}</style>
<main><h1>Europa Clipper flyby</h1><video controls playsinline preload="metadata" poster="poster.png" aria-label="Europa Clipper flyby with instrument PiP and Jupiter reveal"><source src="clipper.mp4" type="video/mp4"><track kind="captions" src="captions.vtt" srclang="en" label="English scene descriptions"><a href="clipper.mp4">Watch or download the MP4</a></video><p>${caption}</p><p><a href="clipper.mp4">Download video</a> · <a href="https://github.com/AaronPlave/cosmolabe">Cosmolabe</a></p></main></html>\n`;
const files = [
  { key: 'clipper.mp4', path: resolve(directory, basename + '.mp4'), type: 'video/mp4' },
  { key: 'poster.png', path: resolve(directory, basename + '-poster.png'), type: 'image/png' },
  { key: 'captions.vtt', path: resolve(directory, basename + '.vtt'), type: 'text/vtt; charset=utf-8' },
  { key: 'capture.json', path: resolve(directory, basename + '.json'), type: 'application/json' },
  { key: 'index.html', body: Buffer.from(player), type: 'text/html; charset=utf-8' },
];
const hash = createHash('sha256');
for (const file of files) { file.body ??= await readFile(file.path); hash.update(file.key); hash.update(file.body); }
const prefix = `showcase/readme/clipper-${hash.digest('hex').slice(0, 16)}`;
const base = process.env.DATA_BASE_URL;
assert.ok(base && new URL(base).protocol === 'https:', 'Set DATA_BASE_URL to the public HTTPS data host');
const storage = createS3Storage();
for (const file of files) {
  const key = prefix + '/' + file.key;
  const previous = await storage.head(key);
  if (previous) assert.equal(previous.size, file.body.length, `Immutable object differs: ${key}`);
  else await storage.put(key, { body: file.body }, { contentType: file.type, cacheControl: 'public,max-age=31536000,immutable' });
  const url = `${base.replace(/\/$/, '')}/${key}`;
  const response = await fetch(url);
  assert.equal(response.status, 200, `${key}: public fetch failed`);
  assert.equal(response.headers.get('content-type')?.split(';')[0], file.type.split(';')[0]);
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),
    createHash('sha256').update(file.body).digest('hex'), `${key}: public bytes differ`);
}
const url = `${base.replace(/\/$/, '')}/${prefix}`;
const range = await fetch(url + '/clipper.mp4', { headers: { Range: 'bytes=0-1023' } });
assert.equal(range.status, 206, 'Video host must support range requests');
assert.equal((await range.arrayBuffer()).byteLength, 1024);
console.log(JSON.stringify({ player: url + '/index.html', video: url + '/clipper.mp4', poster: url + '/poster.png', caption }, null, 2));
