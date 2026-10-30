# Agent tools and Ask Cosmolabe

Cosmolabe can be driven in natural language (#311): a model reads the request, chooses actions from a fixed set of typed tools, and the viewer carries them out. The model is never the source of truth. The catalog, SPICE and host state, mission activities, and the terrain and imagery sources are. The model can only call tools, and every tool answers with what the viewer actually did.

There are two parts, and they share everything:

- **Agent tools** (`createAgentTools` in `@cosmolabe/control`, `viewer.agentTools` in an embed). `ViewerControl` exposed as tools an agent can call, each with a JSON-schema input.
- **Ask Cosmolabe**. An optional prompt panel in the tool rail that runs a model over those tools.

## The tools

Write tools are verbs from the script language (`docs/scripting.md`), run through `execute`, so their capability checks, located refusals and cancellation are the script console's own. This is not a second command system. The curated set is limited to read-only and reversible view operations:

| Effect | Tools |
| --- | --- |
| read | `describeScene`, `resolve`, `searchPlaces`, `listActivities`, `getImagery` |
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
- `searchPlaces` returns places with their source and an `unavailable` reason (see "Places and imagery" in `docs/scripting.md`).
- `getImagery` returns layer attribution, resolution, coverage and load status, and `imageryOnly` when there is no terrain elevation behind the imagery.

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

- **Observed completion.** A camera tool that starts a flight returns when the flight ends (`flightEnd`), and reports `arrived`, `interrupted` or `stopped`.
- **One scene, several drivers.** People, a host and an agent all control the same viewer state. A new task supersedes the running one: its flight wait ends, and its later calls return `superseded`. The flight itself continues unless the newer task moves the camera, as a newer command from a person would.
- **Manual takeover wins.** When a person's drag, zoom or key interrupts a flight, the task's remaining camera tools return `interrupted` instead of re-asserting the view. Its other tools still run. Nothing is retried.
- **Scene guards.** A task holds the `getScene().id` it began with. Once a catalog loads or reloads, every call returns `stale`, and a pending flight wait ends.
- **Cancel** (`task.cancel()`, `tools.cancel()`) stops a flight the task is waiting on, where it is. Nothing else is undone.

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
non-2xx           { error: { message } }
```

`AGENT_WIRE_VERSION` in `@cosmolabe/control` is the version. Content blocks are `text`, `tool_use`, `tool_result` and `provider`. A `text` or `tool_use` block may carry `raw`, the provider's own form of the block. The server that translated a block is the one that reads `raw` and `provider` back, so the viewer never interprets them. The transport checks the version and the shape of every reply before the loop acts on it. Tests use mock transports.

The provider is chosen on the server. The server holds the key, picks the model and translates the wire format to the provider's API. Switching providers or models is a server change. The viewer doesn't change.

## Ask Cosmolabe in the viewer

The prompt exists only when a model proxy is configured. Otherwise the standalone viewer is exactly the static app it was: no rail button, no palette entry.

| Variable | Meaning |
| --- | --- |
| `VITE_ASK_ENDPOINT` | A model proxy speaking the wire format. Relative URLs resolve against the page. |

No key or model setting ever goes into the bundle, development included. `examples/ask-proxy/server.mjs` is a zero-dependency proxy for the Anthropic Messages API, written to be adapted:

```bash
ANTHROPIC_API_KEY=… ALLOW_ORIGIN=http://localhost:5173 node examples/ask-proxy/server.mjs
```

```bash
VITE_ASK_ENDPOINT=http://localhost:8787 npm run dev
```

The proxy:

- accepts only `POST /` from the allowed origins
- builds the provider request itself, so a client cannot choose the model (`ASK_MODEL`, default `claude-opus-5-5`), raise the token cap (`MAX_TOKENS`), or add server tools or MCP servers
- sends only the client tools the viewer defined, and enables the API's server-side refusal fallback
- replaces the provider's error bodies with a one-line message, and reports a rejected key as a 502 from the proxy rather than as the viewer's credentials problem
- rate-limits each client address (`RATE_PER_MINUTE`)

Put real authentication and quotas in front of it before exposing it.

The panel is a normal shell panel: dock, float, minimize, close. Each request shows every step the viewer ran, as the equivalent verb line with a check or a cross. A failed step shows the viewer's own refusal, and a successful read shows its data one click away. The model's short reply comes after the steps.

- **Stop** ends the request and leaves a flight where it is.
- **Closing the panel** stops the request. Minimizing does not.
- **Enter** sends and **Shift+Enter** adds a newline. The prompt takes no global shortcut, so Cmd/Ctrl-K stays the palette and backtick stays the Script tool.

Conversation scope:

- A conversation holds 12 requests, then starts over, with a note in the panel.
- A catalog load stops a running request and starts the next request in a fresh conversation, so nothing about one catalog's objects is applied to another.
- Clear forgets the conversation.
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
