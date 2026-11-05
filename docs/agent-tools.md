# Agent tools and Ask Cosmolabe

Built-in Ask now uses the [discoverable capability catalog and verified receipts](discoverable-capabilities.md). The fixed `createAgentTools` API documented below remains available to existing hosts.

Cosmolabe can be driven in natural language (#311): a model reads the request, chooses actions from a fixed set of typed tools, and the viewer carries them out. The model is never the source of truth. The catalog, SPICE and host state, mission activities, and the terrain and imagery sources are. The model can only call tools, and every tool answers with what the viewer actually did.

There are two parts, and they share everything:

- **Agent tools** (`createAgentTools` in `@cosmolabe/control`, `viewer.agentTools` in an embed). `ViewerControl` exposed as tools an agent can call, each with a JSON-schema input.
- **Ask Cosmolabe**. An optional prompt panel in the tool rail that runs a model over those tools.

## The tools

Write tools are verbs from the script language (`docs/scripting.md`), run through `execute`, so their capability checks, located refusals and cancellation are the script console's own. This is not a second command system. The curated set is limited to read-only and reversible view operations:

| Effect | Tools |
| --- | --- |
| read | `describeScene`, `resolve`, `searchPlaces`, `listActivities`, `getActivity`, `getSurfaceData`, `getImagery` |
| camera | `flyTo`, `jumpTo`, `frameObject`, `track`, `untrack`, `pointAtObject`, `clearLookAt`, `gotoPlace`, `gotoCoordinates`, `viewpoint`, `setFrame`, `circleCenter`, `dolly`, `stopFlight` |
| time | `setTime`, `setTimeRate`, `setPlaying`, `seekActivity` |
| selection | `select`, `deselect`, `selectActivity`, `navigateActivity` |
| display | `setObjectVisible`, `showTrajectory`, `showLabel`, `setLayer`, `showImagery`, `setImageryOpacity`, `showBodyGrid` |

Left out on purpose:

- Captures and recording, because they produce files.
- `wait` and `runTo`.
- Raw camera poses (`setCamera`).
- The grid's fine settings.
- Captions. Prose belongs in the reply.

A tool whose `ViewerControl` method the host lacks is not listed.

The read tools give a model real names to work with, so it doesn't have to guess them. Each is bounded:

- `describeScene` reports:
  - catalog and scene id
  - time (ET and UTC) and playback
  - the selection and the tracked object
  - the flight in progress
  - the selected activity and place
  - object and viewpoint names, the first 40 and 20
  - the imagery stack of the body in focus
  - which capabilities this viewer lacks
- `resolve` matches a phrase against objects, viewpoints, places and activities. It returns the stable id each other tool takes, and flags ambiguity.
- `searchPlaces` returns place coordinates, source category and explicitly approved public provenance/attributes, plus navigation availability (see "Places and imagery" in `docs/scripting.md`).
- `getActivity`, and the selected activity in `describeScene`, carry each activity's `site` and `references` and what they come to in the scene. `site` has a `link`: `direct reference` (the record's `references.location` is a place ref, the only direct link), `name match` (the site's name equals a place's name and the record references no place) or `none`, with the `basis` in words and the matching `places`. A model states the link for what it is rather than guessing from a ref's spelling, and a site no place is named after gives it nothing to navigate to.
- `getSurfaceData` inventories configured terrain elevation/LOD, cube imagery, base/normal/displacement/bump textures, other imagery products and independently managed layers. Product declarations include approved public source identity/revision, frame/datum and cube layout/levels where known. Unapproved metadata is null; its absence establishes neither accuracy nor provenance. Runtime `ready` (manager/manifest initialized), `loaded` (some data resident), `drawn` and `coversView` are separate observations. Null means unknown; resident data is not proof of full view coverage or scientific accuracy. Static texture load/coverage observations are currently unknown. Cube `coversDrawnTiles` reports mandatory-base coverage of drawn terrain blocks only; complete `coversView` remains unknown because undrawn/missing geometry is outside that measurement. Resource endpoints, source URLs and local resource paths are never included in model-facing inventory results.
- `getImagery` describes only independently managed layers. Zero layers does not imply missing terrain, cube imagery or base textures: read `getSurfaceData` for that inventory. It returns approved attribution, resolution, coverage and load status, and `imageryOnly` when there is no terrain elevation behind the imagery.

### What a write leaves in place

Selection is shared state that anything can change, so `selectActivity`, `gotoPlace`, `seekActivity` and `setTime` read the viewer back after they run. A success says what the viewer now reports ("The viewer now reports Flight 5 (…) as the selected activity", "The clock now reads …"), and a selection the viewer does not hold is a `failed` result, not a success. The system prompt asks the model to finish with `describeScene` and report only what it shows, so an answer about the final selection, place, clock and camera is the viewer's own.

### Results

Every call resolves to `{ ok: true, summary, data? }` or `{ ok: false, code, error }`. Calls never throw.

| `code` | Meaning |
| --- | --- |
| `invalid-input` | The input broke the schema (unknown field, missing field, wrong type, value not in the enum). Nothing ran. Input is never coerced. |
| `unknown-tool` | No such tool on this viewer, with a near match if there is one. |
| `refused` | The viewer refused, usually no such name. The message lists or suggests the scene's real names, refs or layer ids. |
| `failed` | The viewer tried and could not, for example a place in a frame it cannot reach, or a flight stopped by another command. |
| `no-scene` | Nothing is loaded. |
| `stale` | The scene changed since the task began. |
| `superseded` | A newer request replaced this task. |
| `cancelled` | The task was stopped. |
| `interrupted` | The person took over the camera. |

### Tasks: completion, supersession, takeover

Calls belong to a **task**. `begin()` starts one per request, and `call(name, input)` is a one-call task.

- **Observed completion.** A camera tool that starts a flight owns that flight, by its id (`getFlight().id`, which `flightEnd` reports back). It returns when that flight ends, and reports `arrived`, `interrupted` or `stopped`. The end of any other flight, started by a host, a person or another request, does not resolve it, and a camera tool that starts no flight (`jumpTo`) waits for none.
- **One scene, several drivers.** People, a host and an agent all control the same viewer state. A new task supersedes the running one: its flight wait ends, and its later calls return `superseded`. The flight itself continues unless the newer task moves the camera, as a newer command from a person would.
- **Manual takeover wins.** When a person's drag, zoom or key interrupts a flight, the task's remaining camera tools return `interrupted` instead of re-asserting the view. Its other tools still run. Nothing is retried.
- **Scene guards.** A task holds the `getScene().id` it began with. Once a catalog loads or reloads, every call returns `stale` before anything runs, and a pending flight wait ends. This check is the adapter's, made on every call, so a place ref or layer id that a new catalog happens to reuse can never act on the new scene. Direct `ViewerControl` callers get the same guard from the `scene` option of the actions that take such an ID (see `docs/scripting.md`).
- **Cancel** (`task.cancel()`, `tools.cancel()`) stops the flight the task started, where it is, if that flight is still the one playing. A flight a person or host started since, or one the task never started, is left alone: Stop then only ends the request. Nothing else is undone.

For inspection of a specific activity moment, Ask requests a pause through `setPlaying` before seeking. `seekActivity` itself retains its existing semantics and never pauses implicitly. Time-write results state whether playback continues or is paused; the final scene read remains the authority. A host refusal is reported without bypassing it.

Place navigation uses a 0.5 km camera range for point anchors whose physical diameter is unknown. This is a navigation preference, not a landing-zone extent or a change to source geometry. Known diameters retain feature fitting; surface eye heights and explicit custom ranges retain their own policy. The same defaults serve UI and control callers.

`describeScene` names `selectedObject`, `selectedActivity` and `selectedPlace` separately. `cameraInput` reports manual navigation even between flights, so the active agent request yields subsequent camera writes to the person. Surface inventory reads use constant-time terrain status rather than traversing cached models for memory accounting.

Host clock and selection ownership is unchanged. Agent writes go through `ViewerControl` like any other viewer-side write, so a host mirroring `time` sees them with `cause: 'viewer'`, and its own `cause: 'host'` echoes stay filterable as before.

## The loop and transports

`runAgent` in `@cosmolabe/control` answers one request. It sends the conversation and the tool list to an `AgentTransport`, runs the tool calls the model asks for, in order, and repeats. It stops when the model has finished, after `maxSteps` round trips (10), or when the task is cancelled or superseded. A reply that arrives after its request was superseded is dropped whole. Transport and tool failures become outcomes, not exceptions.

History is append-only. Provider blocks the loop does not understand, such as a model's thinking, are carried back verbatim, because providers validate a replayed conversation. Each conversation is bounded by starting a new one, never by trimming the old one.

```ts
interface AgentTransport {
  send(request: { system: string; messages: AgentMessage[]; tools: AgentToolDef[] }, signal: ScriptCancelSignal): Promise<{ content: AgentContent[]; stop: AgentStop }>;
}
```

The browser has no provider code. The viewer's one built-in transport, `createHttpTransport(endpoint)`, POSTs the request above as JSON in Cosmolabe's own **wire format** and expects the response back:

```text
POST <endpoint>   { version: 1, system, messages, tools }
200               { version: 1, content, stop }
non-2xx           { error: { message, code? } }
```

`AGENT_WIRE_VERSION` in `@cosmolabe/control` is the version. Content blocks are `text`, `tool_use`, `tool_result` and `provider`. A `text` or `tool_use` block may carry `raw`, the provider's own form of the block. The server that translated a block is the one that reads `raw` and `provider` back, so the viewer never interprets them. `code` is a stable reason the viewer can act on without reading `message`: the example proxy uses `budget_exhausted` and `rate_limited` for its own limits and `upstream_error` for the provider's. The transport throws it as an `AgentTransportError`, and the loop carries it into the request's `error` outcome. The transport checks the version and the shape of every reply before the loop acts on it. Tests use mock transports.

The provider is chosen on the server. The server holds the key, picks the model and translates the wire format to the provider's API. Switching providers or models is a server change. The viewer doesn't change. The example proxy translates to the Anthropic Messages API and to the OpenAI Responses API.

## Ask Cosmolabe in the viewer

The prompt exists only when a model proxy is configured. Otherwise the standalone viewer is exactly the static app it was: no rail button, no palette entry.

| Variable | Meaning |
| --- | --- |
| `VITE_ASK_ENDPOINT` | A model proxy speaking the wire format. Relative URLs resolve against the page. |

No key or model setting ever goes into the bundle, development included. `examples/ask-proxy/server.mjs` is a zero-dependency proxy, written to be adapted. **It is for development and trusted hosts only.** The executable binds explicitly to IPv4 loopback (`127.0.0.1`); use `http://127.0.0.1:8787` as the endpoint.

```bash
ANTHROPIC_API_KEY=… ALLOW_ORIGIN=http://localhost:5173 node examples/ask-proxy/server.mjs
```

```bash
ASK_PROVIDER=openai OPENAI_API_KEY=… ALLOW_ORIGIN=http://localhost:5173 node examples/ask-proxy/server.mjs
```

```bash
VITE_ASK_ENDPOINT=http://127.0.0.1:8787 npm run dev
```

| Variable | Meaning |
| --- | --- |
| `ASK_PROVIDER` | `anthropic` (default) or `openai`. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | The key for the chosen provider. |
| `ALLOW_ORIGIN` | Comma-separated origins allowed to call. Required. |
| `ASK_MODEL` | Default `claude-sonnet-5-5` or `gpt-5.1`. |
| `MAX_TOKENS` | Cap per reply. Default 4096. |
| `ASK_REASONING_EFFORT` | OpenAI only: `reasoning.effort`, when set. |
| `ASK_ANTHROPIC_FALLBACK` | Anthropic only: `1` enables the API's server-side model fallback (a beta). Default off. |
| `RATE_PER_MINUTE` | Requests per client address. Default 20. |
| `ASK_PROMPT_CACHE` | Anthropic only: `0` turns prompt caching off. Default on. |
| `COST_BUDGET_USD` | Optional process estimated-USD guard (default 0/off). Stops subsequent requests after reaching the estimate; unknown pricing refuses calls when this guard is enabled. |
| `TOKEN_BUDGET` | Tokens the process processes before it answers 429 with code `budget_exhausted`: uncached input, cache reads, cache writes and output. Default 2,000,000; 0 for none. It is a count of tokens processed, not of cost: caching lowers what a repeat costs, not this count. |

The proxy:

- accepts only `POST /` from the allowed origins
- builds the provider request itself, so a client cannot choose the model, raise the token cap, or add provider tools (web search, code interpreter) or MCP servers, and it sends only the client function tools the viewer defined
- bounds the request: at most 200 messages, 64 tools and a 20,000-character system prompt
- keeps the conversation at the viewer. Anthropic requests carry the model's own blocks back verbatim. OpenAI requests are stateless (`store: false`) and carry the model's own output items back, with encrypted reasoning, so nothing is kept at the provider
- replaces the provider's error bodies with a one-line message, and reports a rejected key as a 502 from the proxy rather than as the viewer's credentials problem
- ends the upstream call when the viewer goes away (Stop, or closing the panel)
- asks the provider for the one model it is configured with and nothing else. Provider-side model fallback, which can answer on a different and dearer model, is off; `ASK_ANTHROPIC_FALLBACK=1` opts in to the Anthropic API's beta
- caches the Anthropic prompt (5-minute, ephemeral): a breakpoint after the system prompt, which covers the tool schemas that render before it, and one on the last block, so each round of a tool-using request reads the replayed history from the cache. A live sequential tool request shows `cache_creation_input_tokens` and then `cache_read_input_tokens` in the usage line; `ASK_PROMPT_CACHE=0` sends no markers. OpenAI caches automatically, and its cached input is reported as cache reads
- logs a usage line per request, with the model asked for and the model the provider reports as having answered (`unknown` when it reports none), whether the Anthropic reply says a fallback served it (`usage.iterations` holds a `fallback_message` entry; `unknown` when the reply has no list), uncached input, cache reads, cache writes and output as separate fields, and no key or conversation text. Both are the provider's and the proxy's own statements: they are not a billing record, so compare them with the provider's console. It stops at its token budget

This is not a public service. Origin allowlisting and an address rate limit are not authentication: a non-browser client can send any `Origin`, the client supplies the system prompt, messages and tools, and whoever reaches the endpoint spends the key's budget on arbitrary inference. Before exposing it, put caller authentication, per-user quotas and cost ceilings in front of it, and enforce the tool and prompt policy on the server rather than trusting the request.

Both translations are tested against scripted upstreams (`examples/ask-proxy/*.test.mjs`): multi-turn tool use, replay of the provider's own blocks, errors and cancellation. They have not been run against the live APIs from CI; check a real key against the demos before relying on either.

The panel is a normal shell panel: dock, float, minimize, close. It sizes to its content and then scrolls its conversation, with the input kept at the bottom. Each request shows what was asked, the model's one answer, and a line of what the viewer did, such as "3 actions succeeded, 1 refused". The answer is the model's last message: what it says beside tool calls is narration, kept out of it. The model is asked for plain, short prose, and the panel reads the small Markdown subset models write anyway (paragraphs, `-` bullets, `**bold**`, `code`) as text nodes, so nothing can inject markup, links or images. Opening the line lists the actions in plain words ("Flew to Mars") with a check or a cross, and a refusal's own reason. A single Details view under them holds the raw tool calls, results and the model's narration, for debugging.

A request that stops before its answer (the proxy's token budget or rate limit, a provider error, Stop, a scene change) says why and counts what already happened from the actions' own results, for example "4 actions ran (3 done, 1 refused); changes already made to the view remain." A refused action is never counted as done. The panel does not retry, resume or re-issue anything, and does not suggest retrying a request that ran out of the proxy's budget.

- **Stop** ends the request and leaves a flight where it is.
- **Closing the panel** stops the request. Minimizing does not.
- **Enter** sends and **Shift+Enter** adds a newline. The prompt takes no global shortcut, so Cmd/Ctrl-K stays the palette and backtick stays the Script tool.

Conversation scope:

- The model remembers 12 requests, then the next request starts a new conversation. The panel keeps showing the earlier requests, behind a quiet divider ("Earlier requests aren't remembered").
- A catalog load stops a running request, and the next request starts a new conversation (also marked by a divider), so nothing about one catalog's objects is applied to another.
- The panel shows the last 50 requests.
- Clear forgets the conversation and empties the panel.
- Nothing is stored. A reload forgets the conversation.

## In an embed

```ts
const viewer = await mountCosmolabe(el, {
  ask: { transport: myTransport }, // optional: offer the prompt through the host's own model path
});
const task = viewer.agentTools.begin();
const found = await task.call('resolve', { query: 'imaging window', kinds: ['activity'] });
```

- `viewer.agentTools` is always present, bound to `viewer.control`, and dies with `dispose()`. A host that runs its own agent can turn its model's tool calls into `task.call(name, input)` and send back the results it gets. `agentTools.list()` already has the shape MCP and the providers' tool-use APIs expect.
- `ask.transport` adds the panel to the embedded workspace. `createHttpTransport(endpoint)`, exported by the package, is the viewer's own wire-format transport, for a host that runs a proxy like the example. Omit it and there is no prompt: an embed never picks up a deployment's `VITE_ASK_*` settings.
- `examples/embed-host` has a host-owned agent (a fixed plan, not a model) that resolves an activity, seeks it, flies to the spacecraft and reports a refused layer.

## Trust

- Model output and catalog text are both untrusted. Every call is validated against its schema and capability before anything runs. The system prompt tells the model that catalog names and descriptions are data, not instructions.
- No tool reads files, opens network connections, edits catalogs or annotations, or publishes anything. A future tool that changes authored content needs explicit confirmation at that boundary.
- Limits the prompt states and the tools report:
  - Streamed imagery can have partial coverage or failed tiles.
  - `imageryOnly` surfaces have no terrain elevation.
  - Activity times carry their own provenance.
  - External mission state can be unavailable.
  - There is no Event Finder tool yet: the model cannot claim event results.

### Model-visible metadata

`ViewerControl` retains trusted local catalog metadata. Agent reads use an explicit projection shared by scene descriptions, place search, nested activity sites, surface inventories and imagery. Raw resource endpoints/URLs, activity source segments and arbitrary place attributes are omitted. Provenance values are withheld by default, apart from a closed vocabulary of scientific conventions and timing terms. A withheld limitation does not mean no limitations: the model must consult the local record rather than infer accuracy. Display labels, scene-scoped references, coordinates, declared extents, time bounds and runtime status remain available to perform the requested scene operations. Treat those scene contents and the user's prompt as information being shared when enabling a provider.

Trusted hosts can approve exact public metadata values and complete public attribute pairs. Do not construct this policy from arbitrary catalog fields, URL hostnames, or query stripping:

```ts
const publicValues = new Set(['Public dataset DOI', 'public revision 2', 'Public attribution']);
const tools = createAgentTools(control, {
  metadata: {
    publicValue: value => publicValues.has(value),
    publicPlaceField: (key, value) => key === 'Flight' && value === 5,
  },
});
```

Approval restores only the projected provenance fields, never resource endpoints or arbitrary object keys. The standalone Ask panel uses the conservative default. Existing real-provider receipts document earlier acceptance runs; they are not evidence of a new provider run after this metadata change.

On compact screens, the selected activity's timeline inspector yields while the Ask sheet is active. Selection remains unchanged, and closing Ask restores the inspector.


Activity collection reads are compact: `listActivities` returns IDs, names, vehicle/kind, start/end, computed `durationSeconds` (null for missing/instant intervals), and timing status. `sort` (`start`, `duration`, `name`) and `order` (`asc`, `desc`) apply to **all matching records before paging**. Missing durations stay last; `missingDuration` reports their count. Use `offset`/`limit` (maximum 50), `nextOffset`, `returned`, `total` and `complete` to determine scope. `getActivity` retrieves one record's site, references and public provenance without changing the scene. Duration is a catalog interval, never flight distance or guaranteed telemetry. “Longest flight” asks duration versus distance before changing selection/time.

Tool result budgets never cut JSON strings. Oversized activity pages shrink by whole records and return `partial: true` plus a corrected `nextOffset`; oversized individual results are explicitly omitted with `result-too-large` and guidance to request less data. A partial prefix cannot establish an unsorted collection maximum.

Built-in Ask (including the embedded workspace) uses `ask/public-metadata.ts`: a static set of exact reviewed values from built-in MoonFall/Ingenuity definitions and pinned lunar manifests, including LOLA identities/revisions, LROC WAC/NAC attribution and NASA/JPL timing limitations. It is **not populated from loaded catalogs or resource URLs**. Changed/unknown revisions and custom metadata remain withheld; endpoints and arbitrary attributes remain excluded even when their text resembles a public source. Hosts can supply their own reviewed policy through `createAgentTools`.

Raw tokens processed and estimated billed cost are separate. The proxy logs both request/process cost estimates using first-party standard global rates for the **reported answering model**, with cache reads and 5-minute cache writes priced separately. Unknown models show `unknown`; no fallback price is guessed. The reviewed rate table and source links live in `examples/ask-proxy/cost.mjs` (checked 2026-11-01): [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing). Estimates exclude regional/priority/batch rates, discounts and taxes; they are not billing records. Other model IDs require a reviewed rate entry.

For the reported 62,057 raw-token Sonnet 5.5 run (12 uncached input, 43,231 cache reads, 17,898 cache writes, 916 output), standard estimated cost is about **$0.0583**, rather than 62,057 tokens at uncached rates. A raw cap of 50,000 therefore stops that workflow even with effective caching: use `TOKEN_BUDGET=500000` or the 2,000,000 default, plus provider workspace spending limits. `COST_BUDGET_USD` is a separate optional convenience guard; both guards are checked before requests, so concurrent/in-flight requests can overshoot. Provider account spending limits remain the enforcement boundary.
