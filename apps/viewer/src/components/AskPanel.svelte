<script lang="ts">
  /**
   * Ask Cosmolabe (#311) — a compact prompt over the agent tools, not a chat
   * sidebar. A request shows what the person typed, the model's one answer, and
   * a line of what the viewer did ("3 actions succeeded, 1 refused"). Opening
   * that line lists the actions in plain words; one Details view under them
   * holds the raw tool calls, results and the model's narration for anyone
   * debugging. A request that stops early says why and what its actions came
   * to, from their actual results. The panel's own chrome minimizes and closes
   * it; closing stops a running request.
   *
   * Offered only where a model is configured (`askAvailable`).
   */
  import { tick } from 'svelte';
  import { Check, X, Loader2, Square, CornerDownLeft, Trash2, Ban, ChevronRight } from 'lucide-svelte';
  import { toolDef } from '../lib/shell.svelte';
  import {
    ask, submitAsk, stopAsk, clearAsk, endNote, tally, type AskStep, type AskTurn,
  } from '../lib/ask/ask.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let prompt = $state('');
  let transcript = $state<HTMLElement | null>(null);

  // Follow the newest step as it lands.
  $effect(() => {
    void ask.turns.length;
    void ask.turns.at(-1)?.steps.length;
    void ask.turns.at(-1)?.reply;
    void tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }));
  });

  function send() {
    const text = prompt.trim();
    if (!text) return;
    prompt = '';
    void submitAsk(text);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  // Typing here must not drive the scene's keyboard shortcuts; Escape still
  // reaches the shell, which dismisses the panel.
  function containKeys(e: KeyboardEvent) {
    if (e.key !== 'Escape') e.stopPropagation();
  }

  /** "4 actions succeeded, 1 refused": what the viewer did for a request, in a line. */
  function actionsLine(turn: AskTurn): string {
    const { total, done, refused, running, notRun } = tally(turn);
    if (total === 0) return '';
    const parts = [`${done} ${done === 1 ? 'action' : 'actions'} succeeded`];
    if (refused) parts.push(`${refused} refused`);
    if (notRun) parts.push(`${notRun} not run`);
    if (running) parts.push('in progress');
    return parts.join(', ');
  }

  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  /**
   * What a step did, in words: "Flew to Mars". Only the arguments a person
   * would say are used; a place ref or layer id is not one of them.
   */
  const LABELS: Record<string, (i: Record<string, unknown>) => string> = {
    describeScene: () => 'Checked the scene',
    resolve: (i) => `Looked up “${text(i.query) ?? '…'}”`,
    searchPlaces: (i) => `Searched places for “${text(i.query) ?? '…'}”`,
    listActivities: () => 'Listed mission activities',
    getImagery: (i) => `Checked imagery on ${text(i.object) ?? 'a body'}`,
    select: (i) => `Selected ${text(i.object) ?? 'an object'}`,
    deselect: () => 'Cleared the selection',
    flyTo: (i) => `Flew to ${text(i.object) ?? 'an object'}`,
    jumpTo: (i) => `Jumped to ${text(i.object) ?? 'an object'}`,
    frameObject: (i) => `Framed ${text(i.object) ?? 'the tracked object'}`,
    track: (i) => `Tracked ${text(i.object) ?? 'an object'}`,
    untrack: () => 'Stopped tracking',
    pointAtObject: (i) => `Pointed the camera at ${text(i.object) ?? 'an object'}`,
    clearLookAt: () => 'Stopped pointing the camera',
    gotoPlace: () => 'Went to the place',
    gotoCoordinates: (i) => `Went to coordinates on ${text(i.object) ?? 'a body'}`,
    viewpoint: (i) => `Moved to the ${text(i.name) ?? 'saved'} viewpoint`,
    setFrame: () => 'Changed the camera frame',
    circleCenter: () => 'Circled the view',
    dolly: () => 'Moved the camera',
    stopFlight: () => 'Stopped the flight',
    setTime: () => 'Set the time',
    setTimeRate: () => 'Changed the playback rate',
    setPlaying: (i) => (i.playing === false ? 'Paused playback' : 'Started playback'),
    selectActivity: () => 'Selected the activity',
    seekActivity: () => 'Moved the clock to the activity',
    navigateActivity: (i) => `Selected the ${text(i.direction) ?? 'next'} activity`,
    setObjectVisible: (i) => `${i.visible === false ? 'Hid' : 'Showed'} ${text(i.object) ?? 'an object'}`,
    showTrajectory: (i) => `${i.visible === false ? 'Hid' : 'Showed'} the trajectory of ${text(i.object) ?? 'an object'}`,
    showLabel: (i) => `${i.visible === false ? 'Hid' : 'Showed'} the label of ${text(i.object) ?? 'an object'}`,
    setLayer: () => 'Changed a display layer',
    showImagery: (i) => `${i.visible === false ? 'Hid' : 'Showed'} an imagery layer on ${text(i.object) ?? 'a body'}`,
    setImageryOpacity: (i) => `Changed imagery opacity on ${text(i.object) ?? 'a body'}`,
    showBodyGrid: (i) => `${i.visible === false ? 'Hid' : 'Showed'} the grid on ${text(i.object) ?? 'a body'}`,
  };

  function stepLabel(step: AskStep): string {
    const input = step.input && typeof step.input === 'object' ? (step.input as Record<string, unknown>) : {};
    return LABELS[step.name]?.(input) ?? step.name;
  }

  /** Where the step stopped: the viewer's own refusal, short. */
  const stepProblem = (step: AskStep): string | null => (step.result && !step.result.ok ? step.result.error : null);

  /** The latest step, for the "Working…" line. */
  const working = (turn: AskTurn): string | null => {
    const step = turn.steps.at(-1);
    return step && !step.result ? stepLabel(step) : null;
  };

  /** Everything raw, as one block: the tool calls, their results and the model's narration. */
  function details(turn: AskTurn): string {
    const lines = turn.steps.map((s) => JSON.stringify({ tool: s.name, input: s.input, result: s.result }, null, 1));
    if (turn.notes.length) lines.push(`model notes: ${JSON.stringify(turn.notes)}`);
    const out = lines.join('\n');
    return out.length > 8000 ? `${out.slice(0, 8000)}…` : out;
  }
</script>

<InstrumentPanel key="ask" title="Ask Cosmolabe" width={toolDef('ask').width} {onClose} fill>
  {#snippet actions()}
    {#if ask.turns.length > 0}
      <button
        class="ui-meta flex items-center gap-1 rounded px-1.5 py-0.5 text-text-secondary hover:bg-hover hover:text-text-primary"
        onclick={clearAsk}
        title="Forget this conversation"
      >
        <Trash2 size={11} /> Clear
      </button>
    {/if}
  {/snippet}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ask flex min-h-0 flex-1 flex-col" onkeydown={containKeys}>
    <ol bind:this={transcript} class="ask-log flex flex-col gap-3 px-3 pb-2 pt-3" aria-live="polite">
      {#each ask.turns as turn (turn.id)}
        {#if turn.fresh}
          <li class="ask-divider ui-helper flex items-center gap-2 text-text-faint" role="separator" title={turn.fresh}>
            <span class="h-px flex-1 bg-border"></span>
            <span>Earlier requests aren't remembered</span>
            <span class="h-px flex-1 bg-border"></span>
          </li>
        {/if}
        <li class="flex flex-col gap-1">
          <p class="ui-body whitespace-pre-wrap font-medium text-text-primary">{turn.prompt}</p>
          {#if turn.reply}
            <p class="ui-body whitespace-pre-wrap text-text-secondary">{turn.reply}</p>
          {/if}
          {#if turn.status === 'running' && !turn.reply}
            <p class="ui-meta flex items-center gap-1">
              <Loader2 size={11} class="animate-spin" /> Working…{#if working(turn)} <span>{working(turn)}</span>{/if}
            </p>
          {/if}
          {#if endNote(turn)}
            {@const note = endNote(turn)!}
            <p class="ui-helper whitespace-normal {note.tone === 'error' ? 'text-error' : 'text-warning'}" role={note.tone === 'error' ? 'alert' : 'status'}>{note.text}</p>
          {/if}
          {#if turn.steps.length > 0}
            <details class="ask-actions">
              <summary class="ui-helper flex cursor-pointer select-none items-center gap-1">
                <ChevronRight size={10} class="ask-chevron" />
                {actionsLine(turn) || 'Working'}{turn.status === 'running' ? '…' : ''}
              </summary>
              <ul class="mt-1 flex flex-col gap-0.5">
                {#each turn.steps as step (step.id)}
                  <li class="flex items-start gap-1.5">
                    <span class="mt-0.5 shrink-0">
                      {#if !step.result}<Loader2 size={11} class="animate-spin text-text-muted" />
                      {:else if step.result.ok}<Check size={11} class="text-success" />
                      {:else if step.result.code === 'superseded' || step.result.code === 'cancelled'}<Ban size={11} class="text-text-muted" />
                      {:else}<X size={11} class="text-error" />{/if}
                    </span>
                    <span class="ui-helper min-w-0 flex-1 whitespace-normal">
                      <span class="text-text-secondary">{stepLabel(step)}</span>
                      {#if stepProblem(step)}<span class="block text-error">{stepProblem(step)}</span>{/if}
                    </span>
                  </li>
                {/each}
              </ul>
              <details class="ask-details mt-1">
                <summary class="ui-helper cursor-pointer select-none text-text-faint">Details</summary>
                <pre class="ui-helper mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{details(turn)}</pre>
              </details>
            </details>
          {/if}
        </li>
      {/each}
      {#if ask.turns.length === 0}
        <li class="ui-helper whitespace-normal">
          Ask for a place, an object, a mission activity, a time or a layer, e.g. “fly to Jezero and show the available imagery”.
        </li>
      {/if}
    </ol>

    <div class="flex shrink-0 items-end gap-1.5 border-t border-border px-3 py-2">
      <textarea
        bind:value={prompt}
        onkeydown={onKeydown}
        rows="2"
        placeholder="Ask Cosmolabe…"
        aria-label="Request"
        title="A model interprets the request; the viewer's catalog and data remain the source of truth."
        class="ui-control min-w-0 flex-1 resize-none rounded border border-border bg-surface-3 px-1.5 py-1 text-text-primary outline-none focus-visible:border-accent"
      ></textarea>
      {#if ask.running}
        <button class="ask-btn" onclick={stopAsk} aria-label="Stop request" title="Stop: a flight in progress stops where it is">
          <Square size={11} /> Stop
        </button>
      {:else}
        <button class="ask-btn" onclick={send} disabled={prompt.trim() === ''} aria-label="Send request" title="Send (Enter)">
          <CornerDownLeft size={12} />
        </button>
      {/if}
    </div>
  </div>
</InstrumentPanel>

<style>
  /* The log takes the room there is: it grows with the conversation up to the
     panel's height, then scrolls, and the input stays at the bottom. */
  .ask-log {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .ask-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface-3);
    padding: 5px 8px;
    font-size: 11px;
    color: var(--color-text-primary);
    transition: background-color 120ms;
  }
  .ask-btn:hover:not(:disabled) { background: var(--color-hover); }
  .ask-btn:disabled { cursor: not-allowed; opacity: 0.5; }
  .ask-divider { font-size: 10px; }
  .ask-actions > summary :global(.ask-chevron) { transition: transform 120ms; }
  .ask-actions[open] > summary :global(.ask-chevron) { transform: rotate(90deg); }
  /* Disclosures are keyboard-operable, so they show where focus is. */
  .ask-actions > summary:focus-visible,
  .ask-details > summary:focus-visible {
    outline: 1px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
</style>
