<script lang="ts">
  /**
   * Ask Cosmolabe (#311) — a compact prompt over the agent tools, not a chat
   * sidebar. Each request shows the model's short reply and a one-line count
   * of what the viewer did (and refused); the raw actions — the tool calls,
   * their results and refusals — are one click away under it. The panel's own
   * chrome minimizes and closes it; closing stops a running request.
   *
   * Offered only where a model is configured (`askAvailable`).
   */
  import { tick } from 'svelte';
  import { Check, X, Loader2, Square, CornerDownLeft, Trash2, Ban, ChevronRight } from 'lucide-svelte';
  import { toolDef } from '../lib/shell.svelte';
  import {
    ask, submitAsk, stopAsk, clearAsk, MAX_TURNS, type AskStep, type AskStatus, type AskTurn,
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

  /** "3 actions", or "3 actions, 1 refused": what the viewer did for a request, in a line. */
  function actionsLine(turn: AskTurn): string {
    const done = turn.steps.filter((s) => s.result?.ok).length;
    const refused = turn.steps.filter((s) => s.result && !s.result.ok && s.result.code !== 'superseded' && s.result.code !== 'cancelled').length;
    const running = turn.steps.filter((s) => !s.result).length;
    const n = turn.steps.length;
    const parts = [`${n} ${n === 1 ? 'action' : 'actions'}`];
    if (refused) parts.push(`${refused} refused`);
    if (running) parts.push('in progress');
    else if (done + refused < n) parts.push(`${n - done - refused} not run`);
    return parts.join(', ');
  }

  /** The step being worked on, for the "Working…" line. */
  const latestStep = (turn: AskTurn): string | null => {
    const step = turn.steps.at(-1);
    return step && !step.result ? stepLabel(step) : null;
  };

  /** `flyTo Titan` — the step as the equivalent script line, roughly. */
  function stepLabel(step: AskStep): string {
    const values = step.input && typeof step.input === 'object'
      ? Object.values(step.input as Record<string, unknown>).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      : [];
    return [step.name, ...values].join(' ');
  }

  function stepDetail(step: AskStep): string {
    if (!step.result) return '';
    if (!step.result.ok) return step.result.error;
    return step.result.summary;
  }

  function stepData(step: AskStep): string | null {
    if (!step.result?.ok || step.result.data === undefined) return null;
    const text = JSON.stringify(step.result.data, null, 1);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  }

  const ENDINGS: Partial<Record<AskStatus, string>> = {
    cancelled: 'Stopped.',
    superseded: 'Replaced by a newer request.',
    stale: 'The scene changed, so this request stopped.',
    'step-limit': 'Stopped after too many steps.',
    'max-tokens': 'The reply was cut off.',
    refusal: 'The model declined this request.',
  };
</script>

<InstrumentPanel key="ask" title="Ask Cosmolabe" width={toolDef('ask').width} {onClose}>
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
  <div class="flex flex-col gap-2" onkeydown={containKeys}>
      {#if ask.turns.length > 0}
        <ol bind:this={transcript} class="flex max-h-[45vh] flex-col gap-3 overflow-y-auto pr-0.5" aria-live="polite">
          {#each ask.turns as turn (turn.id)}
            {#if turn.fresh}
              <li class="ui-helper flex items-center gap-2 whitespace-normal text-text-faint" role="separator">
                <span class="h-px flex-1 bg-border"></span><span class="max-w-[85%] text-center">{turn.fresh}</span><span class="h-px flex-1 bg-border"></span>
              </li>
            {/if}
            <li class="flex flex-col gap-1">
              <p class="ui-body whitespace-pre-wrap text-text-primary">{turn.prompt}</p>
              {#if turn.reply}
                <p class="ui-body whitespace-pre-wrap text-text-secondary">{turn.reply}</p>
              {/if}
              {#if turn.status === 'running' && !turn.reply}
                <p class="ui-meta flex items-center gap-1">
                  <Loader2 size={11} class="animate-spin" /> Working…{#if latestStep(turn)} <span class="font-mono text-[11px] break-all">{latestStep(turn)}</span>{/if}
                </p>
              {:else if turn.status === 'error'}
                <p class="ui-helper whitespace-normal text-error" role="alert">{turn.error}</p>
              {:else if ENDINGS[turn.status]}
                <p class="ui-helper whitespace-normal text-warning">{ENDINGS[turn.status]}</p>
              {/if}
              {#if turn.steps.length > 0}
                <details class="actions">
                  <summary class="ui-helper flex cursor-pointer select-none items-center gap-1">
                    <ChevronRight size={10} class="actions-chevron" />
                    {actionsLine(turn)}
                  </summary>
                  <ul class="mt-1 flex flex-col gap-0.5 border-l border-border pl-2">
                    {#each turn.steps as step (step.id)}
                      {@const data = stepData(step)}
                      <li class="flex flex-col">
                        <div class="flex items-start gap-1.5">
                          <span class="mt-0.5 shrink-0">
                            {#if !step.result}<Loader2 size={11} class="animate-spin text-text-muted" />
                            {:else if step.result.ok}<Check size={11} class="text-success" />
                            {:else if step.result.code === 'superseded' || step.result.code === 'cancelled'}<Ban size={11} class="text-text-muted" />
                            {:else}<X size={11} class="text-error" />{/if}
                          </span>
                          <span class="min-w-0 flex-1">
                            <span class="font-mono text-[11px] text-text-secondary break-all">{stepLabel(step)}</span>
                            {#if step.result}
                              <span class="ui-helper block whitespace-normal {step.result.ok ? '' : 'text-error'}">{stepDetail(step)}</span>
                            {/if}
                          </span>
                        </div>
                        {#if data}
                          <details class="ml-4">
                            <summary class="ui-helper cursor-pointer select-none">Data</summary>
                            <pre class="ui-helper max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{data}</pre>
                          </details>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </details>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p class="ui-helper whitespace-normal">
          Ask for a place, an object, a mission activity, a time or a layer, e.g. "fly to Jezero and show the available imagery".
        </p>
      {/if}

      <div class="flex items-end gap-1.5">
        <textarea
          bind:value={prompt}
          onkeydown={onKeydown}
          rows="2"
          placeholder="Ask Cosmolabe…"
          aria-label="Request"
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
      <p class="ui-helper whitespace-normal text-text-faint">
        A model interprets the request; the viewer's catalog and data remain the source of truth. The model remembers {MAX_TURNS} requests at a time, and starts fresh when a new scene loads.
      </p>
  </div>
</InstrumentPanel>

<style>
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
  .actions > summary :global(.actions-chevron) { transition: transform 120ms; }
  .actions[open] > summary :global(.actions-chevron) { transform: rotate(90deg); }
</style>
