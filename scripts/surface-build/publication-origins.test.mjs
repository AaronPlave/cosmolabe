import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { verifyPublishedProduct } from './publication.mjs';
import { digest } from './plan.mjs';
import { serializeInventory } from '../data-hosting/lib/publish.mjs';

function fixture({ html404 = false, missingStatus = 404, htmlAsset = false } = {}) {
  const bytes = Buffer.from(JSON.stringify({ source: { version: 'revision' } }));
  const entries = [{ path: 'imagery.json', size: bytes.length, sha256: digest(bytes), gzip: false }];
  const inventory = serializeInventory(entries);
  const product = { kind: 'cube-imagery', productId: 'image', productIdentity: 'a'.repeat(64), prefix: 'cube-imagery/image/build/',
    objects: 1, bytes: bytes.length, entries, inventorySha256: digest(inventory) };
  const manifest = { kind: product.kind, name: product.productId, build: product.productIdentity.slice(0, 32),
    fileCount: 1, totalBytes: bytes.length, inventory: { sha256: product.inventorySha256 }, revision: 'revision', encoding: 'png' };
  const requestedOrigins = [];
  const fetchImpl = async (url, options = {}) => {
    const origin = options.headers?.Origin;
    if (origin) requestedOrigins.push(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable' };
    if (['https://aaronplave.com', 'http://localhost:5173'].includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    if (url.includes('__missing__')) return new Response('missing', { status: missingStatus, headers: { ...headers, 'Content-Type': html404 ? 'text/html' : 'text/plain' } });
    if (url.endsWith('inventory.jsonl.gz')) return new Response(gzipSync(Buffer.from(inventory)), { headers });
    if (htmlAsset && url.endsWith('imagery.json')) return new Response('<html>Not found</html>', { headers: { ...headers, 'Content-Type': 'text/html' } });
    return new Response(url.endsWith('manifest.json') ? JSON.stringify(manifest) : bytes, { headers });
  };
  return { product, fetchImpl, requestedOrigins };
}

describe('publication viewer-origin verification', () => {
  it('verifies the explicitly selected custom deployment and local origins', async () => {
    const f = fixture();
    await expect(verifyPublishedProduct(f.product, { baseUrl: 'https://data.example', fetchImpl: f.fetchImpl,
      origins: ['https://aaronplave.com', 'http://localhost:5173'] })).resolves.toMatchObject({ objects: 1 });
    expect(new Set(f.requestedOrigins)).toEqual(new Set(['https://aaronplave.com', 'http://localhost:5173']));
  });
  it('rejects a selected viewer origin that the host does not allow', async () => {
    const f = fixture();
    await expect(verifyPublishedProduct(f.product, { baseUrl: 'https://data.example', fetchImpl: f.fetchImpl,
      origins: ['https://aaronplave.github.io'] })).rejects.toThrow(/Access-Control-Allow-Origin/);
  });
  it('accepts genuine HTML 404s while verifying every required object', async () => {
    const f = fixture({ html404: true });
    await expect(verifyPublishedProduct(f.product, { baseUrl: 'https://data.example', fetchImpl: f.fetchImpl,
      origins: ['https://aaronplave.com'] })).resolves.toMatchObject({ objects: 1 });
  });
  it('rejects a missing-object HTML page returned with HTTP 200', async () => {
    const f = fixture({ html404: true, missingStatus: 200 });
    await expect(verifyPublishedProduct(f.product, { baseUrl: 'https://data.example', fetchImpl: f.fetchImpl,
      origins: ['https://aaronplave.com'] })).rejects.toThrow(/expected 404/);
  });
  it('rejects a required data object replaced with an HTTP 200 HTML page', async () => {
    const f = fixture({ htmlAsset: true });
    await expect(verifyPublishedProduct(f.product, { baseUrl: 'https://data.example', fetchImpl: f.fetchImpl,
      origins: ['https://aaronplave.com'] })).rejects.toThrow(/not JSON/);
  });
  it.each([[], ['https://aaronplave.com/cosmolabe'], ['*']].map(origins => ({ origins })))('rejects invalid or empty origin configuration $origins', async ({ origins }) => {
    const f = fixture();
    await expect(verifyPublishedProduct(f.product, { baseUrl: 'https://data.example', fetchImpl: f.fetchImpl, origins })).rejects.toThrow(/explicit HTTP/);
    expect(f.requestedOrigins).toEqual([]);
  });
});
