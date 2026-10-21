// Optional, bounded PDS ODE REST metadata client. No viewer imports or raster downloads.
// ODE's deployments/routes differ. The caller supplies a documented Mars metadata URL
// with {page} and {pageSize}, e.g. the ODE Search metadata endpoint from its REST docs.
// Never treat ODE bounding boxes as valid raster masks or infer product channel/accuracy.
const ALLOWED_HOSTS = new Set(['pilot.rsl.wustl.edu', 'oderest.rsl.wustl.edu']);
const MAX_BYTES = 1024 * 1024;

function pageUrl(template, page, pageSize) {
  if (!template.includes('{page}') || !template.includes('{pageSize}')) throw new Error('URL template must include {page} and {pageSize}');
  const url = new URL(template.replaceAll('{page}', String(page)).replaceAll('{pageSize}', String(pageSize)));
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password
    || !/mars/i.test(url.pathname)) throw new Error('Only HTTPS Mars ODE metadata endpoints are allowed');
  return url.toString();
}
function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function string(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
/** Whitelist documented ODE metadata, preserve unknowns rather than guessing. */
export function normalizeOdeMarsProduct(v) {
  if (!object(v)) return null;
  const productId = string(v.pdS4ProductLid) || string(v.pds3ProductId);
  if (!productId) return null;
  const url = string(v.detailUrl);
  return {
    productId, odeProductId: Number.isSafeInteger(v.odeProductId) ? v.odeProductId : null,
    version: string(v.productVersionId), mission: string(v.mission),
    instrument: string(v.instrument), productType: string(v.productType),
    observationUtc: string(v.observationStartUtc),
    detailUrl: url && /^https:\/\//.test(url) ? url : null,
    // No physical GSD, accuracy, valid-pixel mask, datum or derived DTM is implied.
    nativeGsdM: null, accuracyM: null, footprint: null, validPixelCoverage: null,
  };
}
function rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (object(payload)) {
    for (const key of ['products', 'results', 'items', 'data']) if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}
async function boundedJson(response) {
  if (!response.ok) throw new Error('ODE HTTP ' + response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('ODE response body missing');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('ODE response exceeded 1 MiB');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(out));
}
/** Only a caller-invoked Node/CLI adapter; page size and work are explicitly capped. */
export async function fetchOdeMarsMetadata(template, {
  fetchImpl = fetch, pageSize = 25, maxPages = 2, timeoutMs = 12000,
} = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 4
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
    throw new Error('ODE limits: pageSize 1-50, maxPages 1-4, timeoutMs 100-30000');
  const observations = [];
  const diagnostics = [];
  const ids = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = pageUrl(template, page, pageSize);
    let payload;
    try {
      // Manual redirect handling: never follow to an unapproved host or download endpoint.
      payload = await boundedJson(await fetchImpl(url, {
        method: 'GET', redirect: 'error', headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      }));
    } catch (e) {
      diagnostics.push({ severity: 'warning', code: 'ode-unavailable', page, message: String(e) });
      break;
    }
    const products = rows(payload);
    if (!products) {
      diagnostics.push({ severity: 'warning', code: 'ode-unrecognized-payload', page,
        message: 'Unexpected ODE JSON envelope; no products inferred' });
      break;
    }
    let fresh = 0;
    for (const product of products.slice(0, pageSize)) {
      const normalized = normalizeOdeMarsProduct(product);
      if (!normalized) continue;
      const key = normalized.productId + '@' + (normalized.version ?? '');
      if (ids.has(key)) continue;
      ids.add(key); observations.push(normalized); fresh++;
    }
    if (products.length > pageSize) diagnostics.push({ severity: 'warning', code: 'ode-page-truncated', page,
      message: 'Server returned more than requested page size; inspect endpoint pagination behavior' });
    if (products.length < pageSize) break;
    if (fresh === 0) {
      diagnostics.push({ severity: 'warning', code: 'ode-repeated-page', page,
        message: 'Pagination did not advance; stopping to avoid an unbounded search' });
      break;
    }
    if (page === maxPages) diagnostics.push({ severity: 'warning', code: 'ode-page-cap', page,
      message: 'Search stopped at configured maximum; additional archive products may exist' });
  }
  return { version: 1, archive: 'PDS ODE Mars metadata', observations, diagnostics,
    constraints: { pageSize, maxPages, noRasterDownload: true, footprintsUnverified: true } };
}
