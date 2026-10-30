import { afterEach, describe, expect, it } from 'vitest';
import { checkRequest, createProxy, forwardedBetas, rateLimiter } from './server.mjs';

const LIMITS = { models: ['claude-opus-5-5'], maxTokens: 16000 };
const BODY = { model: 'claude-opus-5-5', max_tokens: 64000, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'flyTo', description: 'd', input_schema: { type: 'object' } }] };

describe('ask proxy policy', () => {
  it('caps max_tokens and passes a viewer request', () => {
    expect(checkRequest(BODY, LIMITS)).toEqual({ body: { ...BODY, max_tokens: 16000 } });
  });

  it('refuses other models, server tools, MCP servers and unknown fields', () => {
    expect(checkRequest({ ...BODY, model: 'other' }, LIMITS).error).toContain('model');
    expect(checkRequest({ ...BODY, tools: [{ type: 'web_search_20260209', name: 'web_search' }] }, LIMITS).error).toContain('client tools');
    expect(checkRequest({ ...BODY, mcp_servers: [] }, LIMITS).error).toContain('"mcp_servers"');
    expect(checkRequest([], LIMITS).error).toBeTruthy();
  });

  it('forwards only allowed betas', () => {
    expect(forwardedBetas('server-side-fallback-2026-07-01, mcp-client-2025-11-20')).toEqual(['server-side-fallback-2026-07-01']);
    expect(forwardedBetas(undefined)).toEqual([]);
  });

  it('limits requests per minute', () => {
    let t = 0;
    const allow = rateLimiter(2, () => t);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    t = 60_000;
    expect(allow('a')).toBe(true);
  });
});

describe('ask proxy server', () => {
  let server;
  afterEach(() => server?.close());

  async function start(fetchImpl) {
    server = createProxy({ apiKey: 'secret', origins: ['http://viewer.test'], perMinute: 10, fetchImpl, ...LIMITS });
    await new Promise((r) => server.listen(0, r));
    return `http://127.0.0.1:${server.address().port}/v1/messages`;
  }

  it('forwards with the server-held key and answers with CORS for the allowed origin', async () => {
    const seen = [];
    const url = await start(async (u, init) => {
      seen.push(init);
      return new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), { status: 200 });
    });
    const res = await fetch(url, { method: 'POST', headers: { origin: 'http://viewer.test', 'x-api-key': 'held-by-proxy', 'anthropic-beta': 'server-side-fallback-2026-07-01' }, body: JSON.stringify(BODY) });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://viewer.test');
    expect(seen[0].headers['x-api-key']).toBe('secret');
    expect(seen[0].headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(JSON.parse(seen[0].body).max_tokens).toBe(16000);
  });

  it('refuses other origins without calling upstream', async () => {
    let called = false;
    const url = await start(async () => { called = true; return new Response('{}'); });
    const res = await fetch(url, { method: 'POST', headers: { origin: 'http://evil.test' }, body: JSON.stringify(BODY) });
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });
});
