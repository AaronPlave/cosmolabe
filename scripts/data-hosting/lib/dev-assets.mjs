// Vite-only fallback for absent managed files. Catalog URLs and relative
// manifest references stay local; the registry selects the immutable remote pin.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { joinUrl, remotePrefix } from './datasets.mjs';
import { matchDataset } from './hosted-catalogs.mjs';

export function hostedAssetUrl(relativePath, datasets, baseUrl) {
  if (relativePath.startsWith('/') || relativePath.split('/').some(p => !p || p === '.' || p === '..')) return undefined;
  const match = matchDataset(relativePath, datasets);
  if (!match || !match.ds.build || match.ds.localOnly || !match.rest) return undefined;
  const suffix = match.rest.split('/').map(encodeURIComponent).join('/');
  const url = new URL(joinUrl(baseUrl, remotePrefix(match.ds) + suffix));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('DATA_BASE_URL must use http or https');
  return url;
}

const RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-encoding', 'cache-control',
  'etag', 'last-modified', 'accept-ranges', 'content-range', 'vary',
];

/** Called only after the ordinary local-file lookup failed. Streams raw bytes,
 * preserving Content-Encoding/Length (including compressed terrain), HEAD,
 * range responses and real upstream errors. No credentials or cookies forward. */
export function createDevAssetFallback({ datasets, baseUrl = 'https://data.aaronplave.com', mode = 'auto', timeoutMs = 30000 }) {
  if (mode !== 'auto' && mode !== 'local') throw new Error('DEV_DATA_MODE must be auto or local');
  return (req, res, relativePath) => {
    if (mode === 'local' || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const target = hostedAssetUrl(relativePath, datasets, baseUrl);
    if (!target) return false;
    const requestHeaders = {};
    for (const key of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
      if (req.headers[key]) requestHeaders[key] = req.headers[key];
    }
    // Cache-busting/version query strings retain their normal semantics.
    target.search = new URL(req.url, 'http://localhost').search;
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    let active;
    const send = (attempt = 0) => {
      if (res.destroyed) return;
      let responseReceived = false;
      const upstream = request(target, { method: req.method, headers: requestHeaders }, response => {
        responseReceived = true;
        // A single bounded retry covers transient CDN failures. Never retry a
        // genuine 404 or a response whose bytes have already reached the client.
        if (attempt === 0 && [502, 503, 504].includes(response.statusCode)) {
          response.on('error', () => {});
          response.resume();
          setTimeout(() => send(1), 50);
          return;
        }
        const headers = {};
        for (const key of RESPONSE_HEADERS) if (response.headers[key] !== undefined) headers[key] = response.headers[key];
        // Local aliases can point at a new pin after a config/branch change.
        headers['cache-control'] = 'no-cache';
        res.writeHead(response.statusCode ?? 502, headers);
        response.on('error', error => res.destroy(error));
        response.pipe(res);
      });
      active = upstream;
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Hosted asset request timed out')));
      upstream.on('error', error => {
        if (res.destroyed) return;
        if (res.headersSent) { res.destroy(); return; }
        if (responseReceived) return;
        // A stale keep-alive connection may reset before response headers.
        if (attempt === 0 && ['ECONNRESET', 'EPIPE'].includes(error.code)) { send(1); return; }
        console.warn(`[Vite data fallback] ${req.method} ${target.origin}${target.pathname}: ${error.code ?? error.message}`);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Hosted dataset unavailable');
      });
      upstream.end();
    };
    res.once('close', () => { if (!res.writableFinished) active?.destroy(); });
    send();
    return true;
  };
}
