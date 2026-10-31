import { afterEach, describe, expect, it } from 'vitest';
import { anthropicProvider, createProxy, fromAnthropicMessage, rateLimiter, toAnthropicRequest } from './server.mjs';
import { FALLBACK_BETA } from './anthropic.mjs';

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
    // One model, nothing else: no provider-side fallback unless asked for.
    expect('fallbacks' in body).toBe(false);
    expect(body.tools).toEqual([{ name: 'flyTo', description: 'Fly.', input_schema: WIRE.tools[0].inputSchema }]);
    // Provider blocks and raw blocks go back exactly as the model sent them.
    expect(body.messages[1].content).toEqual([thinking, textBlock, { type: 'tool_use', id: 't1', name: 'flyTo', input: { object: 'Mars' } }]);
    expect(body.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '{"summary":"arrived"}', is_error: false, cache_control: { type: 'ephemeral' } }]);
  });

  it('marks the stable prefix and the growing history for the 5-minute prompt cache, and only those', () => {
    const { body } = toAnthropicRequest(WIRE, LIMITS);
    // The system prompt (and the tools before it) as one breakpoint.
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    // The last block of the conversation as the other; earlier blocks are untouched.
    const marked = body.messages.flatMap((m) => m.content).filter((b) => 'cache_control' in b);
    expect(marked).toHaveLength(1);
    expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(body.tools)).not.toContain('cache_control');
    // The caller's blocks are not mutated.
    expect('cache_control' in WIRE.messages[2].content[0]).toBe(false);
  });

  it('does not mark a thinking block, and sends no cache markers when caching is off', () => {
    const wire = { ...WIRE, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, { role: 'assistant', content: [{ type: 'provider', block: thinking }] }] };
    expect(toAnthropicRequest(wire, LIMITS).body.messages.flatMap((m) => m.content).some((b) => 'cache_control' in b)).toBe(false);
    const off = toAnthropicRequest(WIRE, { ...LIMITS, cache: false }).body;
    expect(off.system).toBe('sys');
    expect(JSON.stringify(off)).not.toContain('cache_control');
  });

  it('requests provider-side model fallback only when configured to', () => {
    expect(toAnthropicRequest(WIRE, { ...LIMITS, fallback: true }).body.fallbacks).toBe('default');
    expect('fallbacks' in toAnthropicRequest(WIRE, { ...LIMITS, fallback: false }).body).toBe(false);
    expect(anthropicProvider.headers('k')).toEqual({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    expect(anthropicProvider.headers('k', { fallback: true })['anthropic-beta']).toBe(FALLBACK_BETA);
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
    // Nothing in the request asks the provider to choose another model.
    expect(seen[0].headers['anthropic-beta']).toBeUndefined();
    expect('fallbacks' in JSON.parse(seen[0].body)).toBe(false);
  });

  it('sends the fallback request and its beta header only when configured', async () => {
    const seen = [];
    const url = await start(async (u, init) => {
      seen.push(init);
      return new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), { status: 200 });
    }, { fallback: true });
    await post(url, WIRE);
    expect(seen[0].headers['anthropic-beta']).toBe(FALLBACK_BETA);
    expect(JSON.parse(seen[0].body).fallbacks).toBe('default');
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
    // The reply names no model here, so the answering model is not claimed.
    expect(usage).toEqual([
      { requestedModel: 'claude-sonnet-5-5', model: 'unknown', uncachedInputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, fallback: null, totalTokens: 1000, spent: 1000, stop: 'end_turn' },
      { requestedModel: 'claude-sonnet-5-5', model: 'unknown', uncachedInputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, fallback: null, totalTokens: 1000, spent: 2000, stop: 'end_turn' },
    ]);
  });

  it('reports whether the provider says a fallback served the reply, from usage.iterations', () => {
    const usage = (iterations) => anthropicProvider.usage({ model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, iterations } });
    // The shape a real reply had: one plain message entry, no fallback entry.
    expect(usage([{ type: 'message', model: null }])).toMatchObject({ fallback: false, cacheReadTokens: 3, cacheWriteTokens: 2 });
    expect(usage([{ type: 'message', model: null }, { type: 'fallback_message', model: 'claude-opus-5-5' }]).fallback).toBe(true);
    expect(usage(undefined).fallback).toBeNull();
  });

  it('logs the model the provider says answered, apart from the one asked for', async () => {
    const usage = [];
    const url = await start(async () => new Response(JSON.stringify({
      model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hi.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200 }), { onUsage: (u) => usage.push(u) });
    await post(url, WIRE);
    expect(usage).toEqual([{ requestedModel: 'claude-sonnet-5-5', model: 'claude-opus-5-5', uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, fallback: null, totalTokens: 12, spent: 12, stop: 'end_turn' }]);
    // Only counts and model names: nothing of the conversation or the key.
    expect(JSON.stringify(usage)).not.toMatch(/secret|"go"|sys/);
  });

  it('counts uncached input, cache reads, cache writes and output toward the budget, and reports them apart', async () => {
    const usage = [];
    let calls = 0;
    // A cold call writes the prefix; a warm one reads it. Both count in full as raw tokens.
    const replies = [
      { input_tokens: 40, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 10 },
      { input_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 20 },
    ];
    const url = await start(async () => new Response(JSON.stringify({ model: 'claude-sonnet-5-5', content: [], stop_reason: 'end_turn', usage: replies[calls++] }), { status: 200 }),
      { tokenBudget: 10_000, onUsage: (u) => usage.push(u) });
    expect((await post(url, WIRE)).status).toBe(200);
    expect((await post(url, WIRE)).status).toBe(200);
    expect(usage.map((u) => [u.uncachedInputTokens, u.cacheWriteTokens, u.cacheReadTokens, u.outputTokens, u.totalTokens, u.spent])).toEqual([
      [40, 5000, 0, 10, 5050, 5050],
      [60, 0, 5000, 20, 5080, 10130],
    ]);
    // 10,130 raw tokens against a 10,000 budget: the cache did not make the count smaller.
    const refused = await post(url, WIRE);
    expect(refused.status).toBe(429);
    expect(calls).toBe(2);
  });

  it('answers its own limits and the provider\'s with different codes', async () => {
    let upstream = 429;
    const url = await start(async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: upstream }), { tokenBudget: 1, onUsage: () => {} });
    // The provider's 429: its code, and its message.
    const theirs = await post(url, WIRE);
    expect(theirs.status).toBe(429);
    expect(await theirs.json()).toEqual({ error: { message: 'model service 429: slow down', code: 'upstream-rate-limited' } });
    upstream = 500;
    expect((await (await post(url, WIRE)).json()).error.code).toBe('upstream-error');
  });

  it('answers a spent budget and a rate limit with codes the viewer can act on', async () => {
    const reply = () => new Response(JSON.stringify({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200 });
    const url = await start(async () => reply(), { tokenBudget: 10, perMinute: 2 });
    expect((await post(url, WIRE)).status).toBe(200);
    const spent = await post(url, WIRE);
    expect(spent.status).toBe(429);
    expect(await spent.json()).toEqual({ error: { message: 'the proxy has spent its token budget', code: 'budget-exhausted' } });
    const limited = await post(url, WIRE); // a third request in the minute
    expect((await limited.json()).error.code).toBe('rate-limited');
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
