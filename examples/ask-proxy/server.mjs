#!/usr/bin/env node
/**
 * A minimal model proxy for the viewer's Ask prompt (#311).
 *
 * The viewer must never hold a permanent API key, so a deployment that offers
 * the prompt points `VITE_ASK_ENDPOINT` at a server like this one: it holds
 * the key, accepts Anthropic Messages requests from the viewer's origin only,
 * narrows them to what the prompt needs, and forwards them.
 *
 * Zero dependencies — Node 20+. An example to adapt, not a hardened service:
 * put your own authentication, quotas and logging in front of it before
 * exposing it to the internet.
 *
 *   ANTHROPIC_API_KEY=…  ALLOW_ORIGIN=http://localhost:5173  node examples/ask-proxy/server.mjs
 *
 * Environment:
 *   ANTHROPIC_API_KEY  required
 *   ALLOW_ORIGIN       required; comma-separated origins allowed to call
 *   PORT               default 8787
 *   ASK_MODELS         comma-separated models clients may request; default claude-opus-5-5
 *   MAX_TOKENS         cap on max_tokens; default 16000
 *   RATE_PER_MINUTE    requests per client address per minute; default 20
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const MAX_BODY_BYTES = 2_000_000;
const ALLOWED_BETAS = new Set(['server-side-fallback-2026-07-01']);

/**
 * Narrow a client's request body to what the prompt needs, or say why not.
 * Only the client tools the viewer defines are allowed: a server tool (web
 * search, code execution) or an MCP server would spend this key on work the
 * viewer never asked for.
 */
export function checkRequest(body, { models, maxTokens }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const allowed = new Set(['model', 'max_tokens', 'system', 'messages', 'tools', 'fallbacks', 'tool_choice', 'output_config', 'thinking', 'metadata']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return { error: `field ${JSON.stringify(key)} is not allowed through this proxy` };
  if (!models.includes(body.model)) return { error: `model must be one of ${models.join(', ')}` };
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { error: 'messages must be a non-empty array' };
  for (const tool of body.tools ?? []) {
    if (!tool || typeof tool !== 'object' || 'type' in tool || typeof tool.name !== 'string' || typeof tool.input_schema !== 'object') {
      return { error: 'only client tools (name, description, input_schema) are allowed' };
    }
  }
  if (body.fallbacks !== undefined && body.fallbacks !== 'default') return { error: 'fallbacks must be "default"' };
  const max = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? Math.min(body.max_tokens, maxTokens) : maxTokens;
  return { body: { ...body, max_tokens: max } };
}

/** The `anthropic-beta` values this proxy forwards. */
export function forwardedBetas(header) {
  return String(header ?? '').split(',').map((s) => s.trim()).filter((b) => ALLOWED_BETAS.has(b));
}

/** A fixed-window counter per client address. */
export function rateLimiter(perMinute, now = () => Date.now()) {
  const windows = new Map();
  return (key) => {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= perMinute;
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createProxy({ apiKey, origins, models, maxTokens, perMinute, fetchImpl = fetch }) {
  const allow = rateLimiter(perMinute);
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && origins.includes(origin)
      ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, OPTIONS',
        // The SDK sends its own telemetry and version headers; none is forwarded.
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'content-type',
        'access-control-max-age': '600',
        vary: 'origin',
      }
      : null;
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(cors ?? {}) });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    const fail = (status, message) => send(status, { type: 'error', error: { type: 'proxy_error', message } });

    if (!cors) return fail(403, 'origin not allowed');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/v1/messages') return fail(404, 'only POST /v1/messages');
    if (!allow(req.socket.remoteAddress ?? 'unknown')) return fail(429, 'too many requests');

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : 'invalid JSON');
    }
    const checked = checkRequest(parsed, { models, maxTokens });
    if (checked.error) return fail(400, checked.error);

    const betas = forwardedBetas(req.headers['anthropic-beta']);
    try {
      const upstream = await fetchImpl(UPSTREAM, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}),
        },
        body: JSON.stringify(checked.body),
      });
      send(upstream.status, await upstream.text());
    } catch {
      fail(502, 'could not reach the model service');
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const origins = (process.env.ALLOW_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!apiKey || origins.length === 0) {
    console.error('ANTHROPIC_API_KEY and ALLOW_ORIGIN are required');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  createProxy({
    apiKey,
    origins,
    models: (process.env.ASK_MODELS ?? 'claude-opus-5-5').split(',').map((s) => s.trim()),
    maxTokens: Number(process.env.MAX_TOKENS ?? 16000),
    perMinute: Number(process.env.RATE_PER_MINUTE ?? 20),
  }).listen(port, () => console.log(`ask proxy on http://localhost:${port} for ${origins.join(', ')}`));
}
