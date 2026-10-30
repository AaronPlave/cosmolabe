<script lang="ts">
  /**
   * Ask Cosmolabe (#311) — a compact prompt over the agent tools, not a chat
   * sidebar. Each request shows what the viewer actually did, step by step,
   * with the tool's own result or refusal one click away, then the model's
   * short reply. The panel's own chrome minimizes and closes it; closing
   * stops a running request.
   *
   * Offered only where a model is configured (`askAvailable`).
   */
  import { tick } from 'svelte';
  import { Check, X, Loader2, Square, CornerDownLeft, KeyRound, Trash2, Ban } from 'lucide-svelte';
  import { toolDef } from '../lib/shell.svelte';
  import {
    ask, submitAsk, stopAsk, clearAsk, askNeedsKey, setAskKey, MAX_TURNS, type AskStep, type AskStatus,
  } from '../lib/ask/ask.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let prompt = $state('');
  let keyDraft = $state('');
  let transcript = $state<HTMLElement | null>(null);
  let input = $state<HTMLTextAreaElement | null>(null);

  const needsKey = $derived(askNeedsKey() && !ask.hasKey);

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

  function useKey(e: SubmitEvent) {
    e.preventDefault();
    setAskKey(keyDraft);
    keyDraft = '';
    void tick().then(() => input?.focus());
  }

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
    {#if needsKey}
      <form class="flex flex-col gap-1.5" onsubmit={useKey}>
        <label class="ui-label" for="ask-key">Anthropic API key</label>
        <div class="flex items-center gap-1.5">
          <input
            id="ask-key"
            type="password"
            autocomplete="off"
            bind:value={keyDraft}
            class="ui-control min-w-0 flex-1 rounded border border-border bg-surface-3 px-1.5 py-1 text-text-primary outline-none focus-visible:border-accent"
          />
          <button type="submit" class="ask-btn" disabled={keyDraft.trim() === ''}><KeyRound size={12} /> Use</button>
        </div>
        <p class="ui-helper whitespace-normal text-warning">
          Development mode. The key stays in this tab's memory until reload and is sent straight to Anthropic. Do not enable this on a deployment other people use.
        </p>
      </form>
    {:else}
      {#if ask.notice}
        <p class="ui-helper whitespace-normal" role="status">{ask.notice}</p>
      {/if}

      {#if ask.turns.length > 0}
        <ol bind:this={transcript} class="flex max-h-[45vh] flex-col gap-3 overflow-y-auto pr-0.5" aria-live="polite">
          {#each ask.turns as turn (turn.id)}
            <li class="flex flex-col gap-1">
              <p class="ui-body whitespace-pre-wrap text-text-primary">{turn.prompt}</p>
              {#if turn.steps.length > 0}
                <ul class="flex flex-col gap-0.5 border-l border-border pl-2">
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
                          {#if step.result && !step.result.ok}
                            <span class="ui-helper block whitespace-normal text-error">{stepDetail(step)}</span>
                          {/if}
                        </span>
                      </div>
                      {#if data}
                        <details class="ml-4">
                          <summary class="ui-helper cursor-pointer select-none">{stepDetail(step)}</summary>
                          <pre class="ui-helper max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{data}</pre>
                        </details>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if turn.reply}
                <p class="ui-body whitespace-pre-wrap text-text-secondary">{turn.reply}</p>
              {/if}
              {#if turn.status === 'running' && !turn.reply}
                <p class="ui-meta flex items-center gap-1"><Loader2 size={11} class="animate-spin" /> Working…</p>
              {:else if turn.status === 'error'}
                <p class="ui-helper whitespace-normal text-error" role="alert">{turn.error}</p>
              {:else if ENDINGS[turn.status]}
                <p class="ui-helper whitespace-normal text-warning">{ENDINGS[turn.status]}</p>
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
          bind:this={input}
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
        A model interprets the request; the viewer's catalog and data remain the source of truth. Up to {MAX_TURNS} requests per conversation, cleared when a new scene loads.
      </p>
    {/if}
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
</style>
