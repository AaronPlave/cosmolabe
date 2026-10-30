import { afterEach, describe, expect, it } from 'vitest';
import { createProxy, fromOpenAIResponse, openaiProvider, toOpenAIRequest } from './server.mjs';

const LIMITS = { model: 'gpt-5.1', maxTokens: 4096 };
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'blob' };
const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Going.', annotations: [] }] };
const call = { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'flyTo', arguments: '{"object":"Mars"}', status: 'completed' };
const WIRE = {
  version: 1,
  system: 'sys',
  tools: [{ name: 'flyTo', description: 'Fly.', effect: 'camera', inputSchema: { type: 'object', properties: { object: { type: 'string' } }, required: ['object'], additionalProperties: false } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'provider', block: reasoning }, { type: 'text', text: 'Going.', raw: message }, { type: 'tool_use', id: 'c1', name: 'flyTo', input: { object: 'Mars' }, raw: call }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: '{"summary":"arrived"}', isError: false }] },
  ],
};

describe('wire → OpenAI Responses', () => {
  it('builds the body itself: stateless, its model and cap, client function tools only', () => {
    const { body } = toOpenAIRequest(WIRE, LIMITS);
    expect(body).toMatchObject({
      model: 'gpt-5.1', instructions: 'sys', max_output_tokens: 4096, store: false, parallel_tool_calls: false, include: ['reasoning.encrypted_content'],
    });
    expect(body.tools).toEqual([{ type: 'function', name: 'flyTo', description: 'Fly.', parameters: WIRE.tools[0].inputSchema, strict: false }]);
    expect(body.reasoning).toBeUndefined();
    expect(toOpenAIRequest(WIRE, { ...LIMITS, reasoningEffort: 'low' }).body.reasoning).toEqual({ effort: 'low' });
  });

  it('sends the model its own output items back verbatim, in order, and the results as function outputs', () => {
    const { body } = toOpenAIRequest(WIRE, LIMITS);
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      reasoning,
      message,
      call,
      { type: 'function_call_output', call_id: 'c1', output: '{"summary":"arrived"}' },
    ]);
  });

  it('rebuilds items for blocks without a raw form, and marks a failed tool result', () => {
    const wire = {
      ...WIRE,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'c2', name: 'flyTo', input: { object: 'Titan' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c2', content: 'no such object', isError: true }] },
      ],
    };
    expect(toOpenAIRequest(wire, LIMITS).body.input).toEqual([
      { role: 'assistant', content: 'Hi' },
      { type: 'function_call', call_id: 'c2', name: 'flyTo', arguments: '{"object":"Titan"}' },
      { type: 'function_call_output', call_id: 'c2', output: 'Error: no such object' },
    ]);
  });

  it('ignores client attempts to choose model, tools or tokens, and refuses malformed input', () => {
    const body = toOpenAIRequest({ ...WIRE, model: 'other', max_tokens: 1e6, max_output_tokens: 1e6 }, LIMITS).body;
    expect(body.model).toBe('gpt-5.1');
    expect(body.max_output_tokens).toBe(4096);
    expect(toOpenAIRequest({ ...WIRE, tools: [{ type: 'web_search', name: 'web_search' }] }, LIMITS).error).toContain('inputSchema');
    expect(toOpenAIRequest({ ...WIRE, messages: [{ role: 'user', content: [{ type: 'provider', block: {} }] }] }, LIMITS).error).toContain('unknown user content block');
    expect(toOpenAIRequest({ ...WIRE, version: 2 }, LIMITS).error).toContain('wire version');
  });
});

describe('OpenAI Responses → wire', () => {
  it('keeps every item for replay and says a function call is a tool use', () => {
    const reply = fromOpenAIResponse({ status: 'completed', output: [reasoning, message, call] });
    expect(reply).toEqual({
      version: 1,
      stop: 'tool_use',
      content: [
        { type: 'provider', block: reasoning },
        { type: 'text', text: 'Going.', raw: message },
        { type: 'tool_use', id: 'c1', name: 'flyTo', input: { object: 'Mars' }, raw: call },
      ],
    });
  });

  it('maps how a reply ended', () => {
    expect(fromOpenAIResponse({ status: 'completed', output: [message] }).stop).toBe('end');
    expect(fromOpenAIResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }).stop).toBe('max_tokens');
    expect(fromOpenAIResponse({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }).stop).toBe('refusal');
    expect(fromOpenAIResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }).stop).toBe('refusal');
    expect(fromOpenAIResponse({ status: 'failed', output: [] }).stop).toBe('other');
  });

  it('hands arguments that are not JSON on as a string, so the schema check refuses them', () => {
    const reply = fromOpenAIResponse({ status: 'completed', output: [{ ...call, arguments: '{"object":' }] });
    expect(reply.content[0].input).toBe('{"object":');
    expect(fromOpenAIResponse({ status: 'completed' })).toBeNull();
    expect(fromOpenAIResponse(null)).toBeNull();
  });
});

describe('ask proxy server, OpenAI provider', () => {
  let server;
  afterEach(() => server?.close());

  async function start(fetchImpl, extra = {}) {
    server = createProxy({ apiKey: 'sk-secret', origins: ['http://viewer.test'], perMinute: 10, provider: openaiProvider, fetchImpl, ...LIMITS, ...extra });
    await new Promise((r) => server.listen(0, r));
    return `http://127.0.0.1:${server.address().port}/`;
  }
  const post = (url, body, init = {}) => fetch(url, { method: 'POST', headers: { origin: 'http://viewer.test', 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });

  it('runs a tool-using turn over two requests, with the key and url its own', async () => {
    const seen = [];
    const url = await start(async (u, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url: u, headers: init.headers, body });
      const reply = body.input.some((i) => i.type === 'function_call_output')
        ? { status: 'completed', output: [{ ...message, content: [{ type: 'output_text', text: 'Done.' }] }], usage: { input_tokens: 50, output_tokens: 5 } }
        : { status: 'completed', output: [reasoning, call], usage: { input_tokens: 40, output_tokens: 10 } };
      return new Response(JSON.stringify(reply), { status: 200 });
    });
    const first = await (await post(url, { ...WIRE, messages: [WIRE.messages[0]] })).json();
    expect(first.stop).toBe('tool_use');
    // The viewer replays what it was sent, plus its result.
    const second = await (await post(url, { ...WIRE, messages: [WIRE.messages[0], { role: 'assistant', content: first.content }, WIRE.messages[2]] })).json();
    expect(second).toMatchObject({ stop: 'end', content: [{ type: 'text', text: 'Done.' }] });
    expect(seen[0].url).toBe('https://api.openai.com/v1/responses');
    expect(seen[0].headers.authorization).toBe('Bearer sk-secret');
    expect(seen[1].body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      reasoning,
      call,
      { type: 'function_call_output', call_id: 'c1', output: '{"summary":"arrived"}' },
    ]);
  });

  it('reports an upstream failure as the proxy\'s, without its credentials problem looking like the viewer\'s', async () => {
    const url = await start(async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }));
    const res = await post(url, WIRE);
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe('model service 401: Incorrect API key provided');
  });

  it('ends the upstream call when the viewer goes away', async () => {
    let upstreamSignal;
    let started;
    const startedPromise = new Promise((r) => { started = r; });
    const aborted = new Promise((resolve) => {
      start(async (u, init) => {
        upstreamSignal = init.signal;
        init.signal.addEventListener('abort', () => resolve('aborted'));
        started();
        return new Promise(() => {}); // the model never answers
      }).then(async (url) => {
        const controller = new AbortController();
        post(url, WIRE, { signal: controller.signal }).catch(() => {});
        await startedPromise;
        controller.abort();
      });
    });
    await expect(aborted).resolves.toBe('aborted');
    expect(upstreamSignal.aborted).toBe(true);
  });
});
