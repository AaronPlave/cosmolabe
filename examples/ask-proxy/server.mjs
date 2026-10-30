#!/usr/bin/env node
/**
 * A minimal model proxy for the viewer's Ask prompt (#311), and the only part
 * of the prompt that knows a model provider.
 *
 * The viewer posts the agent loop's request in Cosmolabe's own wire format
 * (`AGENT_WIRE_VERSION` in `@cosmolabe/control`: `{ version, system,
 * messages, tools }`) and expects `{ version, content, stop }` back. This
 * proxy holds the key, picks the model, and translates both ways to the
 * Anthropic Messages API. Serving another provider means another translation
 * here; the viewer does not change.
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
 *   ASK_MODEL          default claude-opus-5-5
 *   MAX_TOKENS         default 16000
 *   RATE_PER_MINUTE    requests per client address per minute; default 20
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const WIRE_VERSION = 1;
const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 200;

const fail = (error) => ({ error });

/** One wire content block as an Anthropic block, or an error string. */
function toAnthropicBlock(c, role) {
  if (!c || typeof c !== 'object') return 'content blocks must be objects';
  switch (c.type) {
    case 'text':
      if (typeof c.text !== 'string') return 'text blocks need text';
      return role === 'assistant' && c.raw ? c.raw : { type: 'text', text: c.text };
    case 'tool_use':
      if (role !== 'assistant') return 'tool_use belongs to the assistant';
      return c.raw ?? { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result':
      if (role !== 'user' || typeof c.toolUseId !== 'string' || typeof c.content !== 'string') return 'malformed tool_result';
      return { type: 'tool_result', tool_use_id: c.toolUseId, content: c.content, is_error: c.isError === true };
    case 'provider':
      // The model's own blocks (its thinking, say), carried back on its turns.
      if (role !== 'assistant' || !c.block || typeof c.block !== 'object') return 'provider blocks belong to the assistant';
      return c.block;
    default:
      return `unknown content block ${JSON.stringify(c.type)}`;
  }
}

/**
 * The viewer's wire request as an Anthropic Messages body, or `{ error }`.
 * The proxy builds the body itself, so a client cannot choose the model, add
 * server tools or MCP servers, or raise the token cap.
 */
export function toAnthropicRequest(wire, { model, maxTokens }) {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return fail('body must be a JSON object');
  if (wire.version !== WIRE_VERSION) return fail(`wire version must be ${WIRE_VERSION}`);
  if (typeof wire.system !== 'string') return fail('system must be a string');
  if (!Array.isArray(wire.messages) || wire.messages.length === 0 || wire.messages.length > MAX_MESSAGES) return fail(`messages must be 1 to ${MAX_MESSAGES} entries`);
  if (!Array.isArray(wire.tools)) return fail('tools must be an array');
  const tools = [];
  for (const t of wire.tools) {
    if (!t || typeof t.name !== 'string' || typeof t.description !== 'string' || !t.inputSchema || typeof t.inputSchema !== 'object') return fail('each tool needs name, description and inputSchema');
    tools.push({ name: t.name, description: t.description, input_schema: t.inputSchema });
  }
  const messages = [];
  for (const m of wire.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || !Array.isArray(m.content)) return fail('each message needs a role and content');
    const content = [];
    for (const c of m.content) {
      const block = toAnthropicBlock(c, m.role);
      if (typeof block === 'string') return fail(block);
      content.push(block);
    }
    messages.push({ role: m.role, content });
  }
  return {
    body: {
      model,
      max_tokens: maxTokens,
      system: wire.system,
      messages,
      tools,
      // A declined request is retried on the model the API picks for that
      // category, inside the same call (with the beta header below).
      fallbacks: 'default',
    },
  };
}

const STOPS = { end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal' };

/** An Anthropic reply in the wire format. Every block is kept for replay. */
export function fromAnthropicMessage(message) {
  const content = (message.content ?? []).map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text, raw: block };
    if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input, raw: block };
    return { type: 'provider', block };
  });
  return { version: WIRE_VERSION, content, stop: STOPS[message.stop_reason] ?? 'other' };
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

export function createProxy({ apiKey, origins, model, maxTokens, perMinute, fetchImpl = fetch }) {
  const allow = rateLimiter(perMinute);
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && origins.includes(origin)
      ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'origin',
      }
      : null;
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(cors ?? {}) });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    const fail = (status, message) => send(status, { error: { message } });

    if (!cors) return fail(403, 'origin not allowed');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/') return fail(404, 'only POST /');
    if (!allow(req.socket.remoteAddress ?? 'unknown')) return fail(429, 'too many requests');

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : 'invalid JSON');
    }
    const request = toAnthropicRequest(parsed, { model, maxTokens });
    if (request.error) return fail(400, request.error);

    let upstream;
    try {
      upstream = await fetchImpl(UPSTREAM, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify(request.body),
      });
    } catch {
      return fail(502, 'could not reach the model service');
    }
    const reply = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      // The provider's message, not its body: nothing else of it is the viewer's business.
      const message = reply?.error?.message ?? 'no detail';
      return fail(upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status, `model service ${upstream.status}: ${message}`);
    }
    if (!reply || !Array.isArray(reply.content)) return fail(502, 'the model service sent a malformed reply');
    send(200, fromAnthropicMessage(reply));
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
    model: process.env.ASK_MODEL ?? 'claude-opus-5-5',
    maxTokens: Number(process.env.MAX_TOKENS ?? 16000),
    perMinute: Number(process.env.RATE_PER_MINUTE ?? 20),
  }).listen(port, () => console.log(`ask proxy on http://localhost:${port} for ${origins.join(', ')}; set VITE_ASK_ENDPOINT=http://localhost:${port}`));
}
