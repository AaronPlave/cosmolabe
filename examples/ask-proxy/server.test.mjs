import { afterEach, describe, expect, it } from 'vitest';
import { createProxy, fromAnthropicMessage, rateLimiter, toAnthropicRequest } from './server.mjs';

const LIMITS = { model: 'claude-sonnet-5-5', maxTokens: 4096 };
const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
const textBlock = { type: 'text', text: 'Going.', citations: null };
const WIRE = {
  version: 1,
  system: 'sys',
  tools: [{ name: 'flyTo', description: 'Fly.', effect: 'camera', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'provider', block: thinking }, { type: 'text', text: 'Going.', raw: textBlock }, { type: 'tool_use', id: 't1', name: 'flyTo', input: { object: 'Mars' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '{"summary":"arrived"}', isError: false }] },
  ],
};

describe('wire → Anthropic', () => {
  it('builds the body itself: its model, its cap, client tools only', () => {
    const { body } = toAnthropicRequest(WIRE, LIMITS);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(4096);
    expect(body.fallbacks).toBe('default');
    expect(body.tools).toEqual([{ name: 'flyTo', description: 'Fly.', input_schema: WIRE.tools[0].inputSchema }]);
    // Provider blocks and raw blocks go back exactly as the model sent them.
    expect(body.messages[1].content).toEqual([thinking, textBlock, { type: 'tool_use', id: 't1', name: 'flyTo', input: { object: 'Mars' } }]);
    expect(body.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '{"summary":"arrived"}', is_error: false }]);
  });

  it('ignores client attempts to choose model or tokens, and refuses malformed input', () => {
    expect(toAnthropicRequest({ ...WIRE, model: 'other', max_tokens: 1e6 }, LIMITS).body.model).toBe('claude-sonnet-5-5');
    expect(toAnthropicRequest({ ...WIRE, version: 2 }, LIMITS).error).toContain('wire version');
    expect(toAnthropicRequest({ ...WIRE, tools: [{ type: 'web_search_20260209', name: 'web_search' }] }, LIMITS).error).toContain('inputSchema');
    expect(toAnthropicRequest({ ...WIRE, messages: [{ role: 'user', content: [{ type: 'provider', block: {} }] }] }, LIMITS).error).toContain('assistant');
    expect(toAnthropicRequest({ ...WIRE, messages: [{ role: 'system', content: [] }] }, LIMITS).error).toBeTruthy();
    expect(toAnthropicRequest([], LIMITS).error).toBeTruthy();
  });
});

describe('Anthropic → wire', () => {
  it('keeps every block for replay and maps stop reasons', () => {
    const reply = fromAnthropicMessage({ stop_reason: 'tool_use', content: [thinking, textBlock, { type: 'tool_use', id: 'a', name: 'select', input: {} }] });
    expect(reply).toEqual({
      version: 1,
      stop: 'tool_use',
      content: [
        { type: 'provider', block: thinking },
        { type: 'text', text: 'Going.', raw: textBlock },
        { type: 'tool_use', id: 'a', name: 'select', input: {}, raw: { type: 'tool_use', id: 'a', name: 'select', input: {} } },
      ],
    });
    expect(fromAnthropicMessage({ stop_reason: 'end_turn', content: [] }).stop).toBe('end');
    expect(fromAnthropicMessage({ stop_reason: 'refusal', content: [] }).stop).toBe('refusal');
    expect(fromAnthropicMessage({ stop_reason: 'pause_turn', content: [] }).stop).toBe('other');
  });
});

describe('rate limit', () => {
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

  async function start(fetchImpl, extra = {}) {
    server = createProxy({ apiKey: 'secret', origins: ['http://viewer.test'], perMinute: 10, fetchImpl, ...LIMITS, ...extra });
    await new Promise((r) => server.listen(0, r));
    return `http://127.0.0.1:${server.address().port}/`;
  }
  const post = (url, body, origin = 'http://viewer.test') => fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('answers in the wire format, with the server-held key upstream', async () => {
    const seen = [];
    const url = await start(async (u, init) => {
      seen.push(init);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi.' }], stop_reason: 'end_turn' }), { status: 200 });
    });
    const res = await post(url, WIRE);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://viewer.test');
    expect(await res.json()).toEqual({ version: 1, stop: 'end', content: [{ type: 'text', text: 'Hi.', raw: { type: 'text', text: 'Hi.' } }] });
    expect(seen[0].headers['x-api-key']).toBe('secret');
    expect(seen[0].headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
  });

  it('reports an upstream failure without its credentials problem looking like the viewer\'s', async () => {
    const url = await start(async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }));
    const res = await post(url, WIRE);
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe('model service 401: invalid x-api-key');
  });

  it('accounts for the tokens it spends and stops at its budget', async () => {
    const usage = [];
    let calls = 0;
    const url = await start(async () => {
      calls++;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi.' }], stop_reason: 'end_turn', usage: { input_tokens: 700, output_tokens: 300 } }), { status: 200 });
    }, { tokenBudget: 1500, onUsage: (u) => usage.push(u) });
    expect((await post(url, WIRE)).status).toBe(200);
    expect((await post(url, WIRE)).status).toBe(200);
    // 2000 spent against a 1500 budget: the next request is not sent upstream.
    const refused = await post(url, WIRE);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.message).toContain('token budget');
    expect(calls).toBe(2);
    expect(usage).toEqual([
      { model: 'claude-sonnet-5-5', inputTokens: 700, outputTokens: 300, spent: 1000, stop: 'end_turn' },
      { model: 'claude-sonnet-5-5', inputTokens: 700, outputTokens: 300, spent: 2000, stop: 'end_turn' },
    ]);
  });

  it('bounds what a client may send: tools and system prompt', () => {
    const manyTools = Array.from({ length: 65 }, (_, i) => ({ ...WIRE.tools[0], name: `t${i}` }));
    expect(toAnthropicRequest({ ...WIRE, tools: manyTools }, LIMITS).error).toMatch(/at most 64/);
    expect(toAnthropicRequest({ ...WIRE, system: 'x'.repeat(20_001) }, LIMITS).error).toMatch(/at most 20000/);
  });

  it('refuses other origins and bad requests without calling upstream', async () => {
    let called = false;
    const url = await start(async () => { called = true; return new Response('{}'); });
    expect((await post(url, WIRE, 'http://evil.test')).status).toBe(403);
    expect((await post(url, { ...WIRE, version: 0 })).status).toBe(400);
    expect(called).toBe(false);
  });
});
