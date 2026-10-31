#!/usr/bin/env node
/**
 * A minimal model proxy for the viewer's Ask prompt (#311), and the only part
 * of the prompt that knows a model provider.
 *
 * The viewer posts the agent loop's request in Cosmolabe's own wire format
 * (`AGENT_WIRE_VERSION` in `@cosmolabe/control`: `{ version, system,
 * messages, tools }`) and expects `{ version, content, stop }` back. This
 * proxy holds the key, picks the model, and translates both ways to a
 * provider's API: the Anthropic Messages API (`anthropic.mjs`) or the OpenAI
 * Responses API (`openai.mjs`). Serving another provider means another
 * translation here; the viewer does not change.
 *
 * Zero dependencies — Node 20+. **For development and trusted hosts only.**
 * Origin allowlisting and a per-address rate limit are not authentication: any
 * non-browser client can send an `Origin` header, and whoever reaches this
 * endpoint spends the key's budget on inference. Before exposing it, put your
 * own caller authentication and per-user quotas in front of it. What it does
 * enforce itself: a fixed model and token cap (the client chooses neither),
 * limits on the request's size, a total token budget for the process, and a
 * usage line per request that names the model asked for and the model the
 * provider says answered (`unknown` when it does not say).
 *
 * No provider-side model fallback is requested: a request for one model is
 * answered by that model or fails. Set ASK_ANTHROPIC_FALLBACK=1 to let the
 * Anthropic API retry a declined request on another model of its choosing,
 * which can cost more; the usage line then shows which model answered.
 *
 *   ANTHROPIC_API_KEY=…  ALLOW_ORIGIN=http://localhost:5173  node examples/ask-proxy/server.mjs
 *   ASK_PROVIDER=openai OPENAI_API_KEY=…  ALLOW_ORIGIN=…      node examples/ask-proxy/server.mjs
 *
 * Environment:
 *   ASK_PROVIDER       anthropic (default) or openai
 *   ANTHROPIC_API_KEY  required for anthropic
 *   OPENAI_API_KEY     required for openai
 *   ALLOW_ORIGIN       required; comma-separated origins allowed to call
 *   PORT               default 8787
 *   ASK_MODEL          default claude-sonnet-5-5 (anthropic) or gpt-5.1 (openai)
 *   MAX_TOKENS         per reply; default 4096
 *   ASK_REASONING_EFFORT  openai only; passed as `reasoning.effort` when set
 *   ASK_ANTHROPIC_FALLBACK  anthropic only; 1 enables the API's server-side
 *                      model fallback (a beta); default off
 *   RATE_PER_MINUTE    requests per client address per minute; default 20
 *   TOKEN_BUDGET       input + output tokens this process will spend before it
 *                      answers 429; default 2000000, 0 for none
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { anthropicProvider, fromAnthropicMessage, toAnthropicRequest } from './anthropic.mjs';
import { fromOpenAIResponse, openaiProvider, toOpenAIRequest } from './openai.mjs';

export { anthropicProvider, fromAnthropicMessage, toAnthropicRequest, fromOpenAIResponse, openaiProvider, toOpenAIRequest };

const MAX_BODY_BYTES = 2_000_000;

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

export function createProxy({
  apiKey, origins, model, maxTokens, perMinute, provider = anthropicProvider, reasoningEffort, fallback = false,
  tokenBudget = 0, onUsage = () => {}, fetchImpl = fetch,
}) {
  const allow = rateLimiter(perMinute);
  let spent = 0;
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
    if (tokenBudget > 0 && spent >= tokenBudget) return fail(429, 'the proxy has spent its token budget');

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : 'invalid JSON');
    }
    const request = provider.toRequest(parsed, { model, maxTokens, reasoningEffort, fallback });
    if (request.error) return fail(400, request.error);

    // The client going away (the viewer's Stop) ends the upstream call too.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    let upstream;
    try {
      upstream = await fetchImpl(provider.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...provider.headers(apiKey, { fallback }) },
        body: JSON.stringify(request.body),
        signal: controller.signal,
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
    const wire = provider.fromResponse(reply);
    if (!wire) return fail(502, 'the model service sent a malformed reply');
    const usage = provider.usage(reply);
    spent += usage.inputTokens + usage.outputTokens;
    // `requestedModel` is this proxy's configuration; `model` is what the
    // provider reported, or 'unknown'. Neither is a statement about billing.
    onUsage({ requestedModel: model, ...usage, model: usage.model ?? 'unknown', spent });
    send(200, wire);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const providers = { anthropic: [anthropicProvider, 'ANTHROPIC_API_KEY'], openai: [openaiProvider, 'OPENAI_API_KEY'] };
  const choice = process.env.ASK_PROVIDER ?? 'anthropic';
  const [provider, keyVar] = providers[choice] ?? [];
  const origins = (process.env.ALLOW_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!provider) {
    console.error(`ASK_PROVIDER must be one of: ${Object.keys(providers).join(', ')}`);
    process.exit(1);
  }
  const apiKey = process.env[keyVar];
  if (!apiKey || origins.length === 0) {
    console.error(`${keyVar} and ALLOW_ORIGIN are required`);
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  createProxy({
    apiKey,
    origins,
    provider,
    model: process.env.ASK_MODEL ?? provider.defaultModel,
    maxTokens: Number(process.env.MAX_TOKENS ?? 4096),
    reasoningEffort: process.env.ASK_REASONING_EFFORT || undefined,
    fallback: process.env.ASK_ANTHROPIC_FALLBACK === '1',
    perMinute: Number(process.env.RATE_PER_MINUTE ?? 20),
    tokenBudget: Number(process.env.TOKEN_BUDGET ?? 2_000_000),
    onUsage: (u) => console.log(`usage requested=${u.requestedModel} answered=${u.model}: ${u.inputTokens} in, ${u.outputTokens} out (${u.spent} total this run) stop=${u.stop}`),
  }).listen(port, () => {
    console.log(`ask proxy (${provider.name}) on http://localhost:${port} for ${origins.join(', ')}; set VITE_ASK_ENDPOINT=http://localhost:${port}`);
    console.warn('development proxy: no caller authentication. Do not expose it publicly.');
  });
}
