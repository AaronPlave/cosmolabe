<script lang="ts">
  /**
   * Ask Cosmolabe (#311) — a compact prompt over the agent tools, not a chat
   * sidebar. A request shows what the person typed, the model's one answer, and
   * a quiet action status. Opening
   * that line lists the actions in plain words; one Details view under them
   * holds every raw tool call and full result, one collapsible step each, the
   * model's narration and a copy of the whole trace, for anyone debugging. A request that stops early says why and what its actions came
   * to, from their actual results. The panel's own chrome minimizes and closes
   * it; closing stops a running request.
   *
   * Offered only where a model is configured (`askAvailable`).
   */
  import { tick } from 'svelte';
  import { Check, X, Loader2, Square, CornerDownLeft, Trash2, Ban, ChevronRight } from 'lucide-svelte';
  import { toolDef } from '../lib/shell.svelte';
  import {
    ask, askHelp, askApproval, answerAskApproval, submitAsk, stopAsk, clearAsk, endNote, checkNote, type AskStep, type AskTurn,
  } from '../lib/ask/ask.svelte';
  import { actionMetadata, actionStatus, approvalPresentation } from '../lib/ask/presentation';
  import type { AskExample, AskHelp } from '@cosmolabe/control';
  import { etToUtcString, vs } from '../lib/viewer-state.svelte';
  import { parseAnswer, type AnswerBlock, type AnswerSpan } from '../lib/ask/answer-text';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let prompt = $state('');
  let help = $state<AskHelp | null>(null);
  let composer = $state<HTMLTextAreaElement | null>(null);
  $effect(() => { void vs.selectedBodyName; void vs.trackedBodyName; void vs.sceneLoaded; help = null; });
  async function chooseExample(example: AskExample) {
    prompt = example.prompt; help = null; await tick(); composer?.focus();
  }
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

  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  /**
   * What a step did, in words: "Flew to Mars". Only the arguments a person
   * would say are used; a place ref or layer id is not one of them.
   */
  const LABELS: Record<string, (i: Record<string, unknown>) => string> = {
    describeScene: () => 'Checked the scene',
    listCapabilities: () => 'Found available actions',
    describeCapabilities: () => 'Checked action requirements',
    getOperationResult: () => 'Checked an action result',
    resolve: (i) => `Looked up “${text(i.query) ?? '…'}”`,
    searchPlaces: (i) => `Searched places for “${text(i.query) ?? '…'}”`,
    listActivities: () => 'Listed mission activities',
    getActivity: () => 'Checked activity details',
    getSurfaceData: (i) => `Checked surface datasets on ${text(i.object) ?? 'a body'}`,
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
    circleCenterRight: (i) => `Swung the view right ${i.degrees ?? ''}°`,
    circleCenterLeft: (i) => `Swung the view left ${i.degrees ?? ''}°`,
    circleCenterUp: (i) => `Swung the view up ${i.degrees ?? ''}°`,
    circleCenterDown: (i) => `Swung the view down ${i.degrees ?? ''}°`,
    composeView: (i) => `Rotated around ${text(i.anchor) ?? 'the tracked object'} to show ${text(i.target) ?? 'the target'}`,
    getViewComposition: () => 'Checked what is in view',
    checkGoal: () => 'Checked the result in the viewer',
    dolly: () => 'Moved the camera',
    stopFlight: () => 'Stopped the flight',
    setTime: () => 'Set the time',
    setTimeRate: () => 'Changed the playback rate',
    setPlaying: (i) => (i.on === false ? 'Paused playback' : 'Started playback'),
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
    if (step.name === 'invokeCapability') {
      const name = typeof input.id === 'string' ? input.id.split('.').at(-1)! : '';
      const args = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {};
      return LABELS[name]?.(args) ?? actionMetadata(step).label;
    }
    return LABELS[step.name]?.(input) ?? actionMetadata(step).label;
  }

  /** The whole raw trace, untruncated: every tool call with its input and full host result, and the model's narration. */
  function trace(turn: AskTurn): string {
    return JSON.stringify({ prompt: turn.prompt, steps: turn.steps.map((s) => ({ tool: s.name, input: s.input, result: s.result })), notes: turn.notes }, null, 1);
  }
  let copied = $state<number | null>(null);
  async function copyTrace(turn: AskTurn) {
    try { await navigator.clipboard.writeText(trace(turn)); copied = turn.id; } catch { copied = null; }
  }
</script>

{#snippet spans(list: readonly AnswerSpan[])}{#each list as span}{#if span.bold}<strong class="font-semibold text-text-primary">{span.text}</strong>{:else if span.code}<code class="font-mono text-[11px] text-text-primary">{span.text}</code>{:else}{span.text}{/if}{/each}{/snippet}

{#snippet answerBlocks(blocks: readonly AnswerBlock[])}
  {#each blocks as block}
    {#if block.kind === 'details'}
      <details class="ask-answer-details text-text-secondary">
        <summary class="ui-helper cursor-pointer">{@render spans(block.summary)}</summary>
        <div class="mt-1 flex flex-col gap-1.5">{@render answerBlocks(block.blocks)}</div>
      </details>
    {:else if block.kind === 'ul'}
      <ul class="flex list-disc flex-col gap-0.5 pl-4">
        {#each block.items as item}<li>{@render spans(item)}</li>{/each}
      </ul>
    {:else}
      <p class="whitespace-pre-wrap">{@render spans(block.spans)}</p>
    {/if}
  {/each}
{/snippet}

<InstrumentPanel key="ask" title="Ask Cosmolabe" width={toolDef('ask').width} {onClose} fill>
  {#snippet actions()}
    {#if import.meta.env.DEV}
      <span class="ui-meta px-1 text-text-faint" data-ask-mode={ask.toolMode} data-ask-catalog="shared-capability-v1" title="Shared capability catalog: Fixed uses a compact direct schema shortlist; Discovery uses registry tools">{ask.toolMode === 'discovery' ? 'Discovery' : 'Fixed'}</span>
    {/if}
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
        <li class="ask-turn flex flex-col gap-2">
          <p class="ask-prompt ui-body ml-auto max-w-[92%] self-end rounded-md border border-border bg-hover px-2.5 py-1.5 whitespace-pre-wrap text-text-primary">{turn.prompt}</p>
          {#if turn.reply}
            <!-- The answer's Markdown subset as text nodes: no markup can come through. -->
            <div class="ask-answer ui-body w-full flex flex-col gap-1.5 text-text-primary">
              {@render answerBlocks(parseAnswer(turn.reply))}
            </div>
          {/if}
          <p class="ask-status ui-meta flex items-center gap-1 text-text-muted" role="status">
            {#if turn.status === 'running' && !askApproval.pending}<Loader2 size={11} class="animate-spin" />{/if}
            {actionStatus(turn, turn.status === 'running' && !!askApproval.pending)}
          </p>
          {#if checkNote(turn)}
            {@const check = checkNote(turn)!}
            <p class="ui-helper whitespace-normal {check.tone === 'warning' ? 'text-warning' : 'text-text-faint'}" role="status">{check.text}</p>
          {/if}
          {#if endNote(turn, stepLabel)}
            {@const note = endNote(turn, stepLabel)!}
            <p class="ui-helper whitespace-normal {note.tone === 'error' ? 'text-error' : 'text-warning'}" role={note.tone === 'error' ? 'alert' : 'status'}>{note.text}</p>
          {/if}
          {#if turn.steps.length > 0}
            <details class="ask-actions">
              <summary class="ui-helper flex cursor-pointer select-none items-center gap-1">
                <ChevronRight size={10} class="ask-chevron" />
                Action details
                {#if turn.stats}<span class="text-text-faint">· {turn.stats.rounds} model {turn.stats.rounds === 1 ? 'round' : 'rounds'}{#if turn.stats.rawTokens !== null} · {Math.round(turn.stats.rawTokens / 1000)}k tokens{/if}</span>{/if}
              </summary>
              <ul class="mt-1 flex flex-col gap-0.5">
                {#each turn.steps.filter(s => !actionMetadata(s).diagnostic) as step (step.id)}
                  <li class="flex items-start gap-1.5">
                    <span class="mt-0.5 shrink-0">
                      {#if !step.result}<Loader2 size={11} class="animate-spin text-text-muted" />
                      {:else if step.result.receipt?.status === 'partial'}<Ban size={11} class="text-warning" />
                      {:else if step.result.ok}<Check size={11} class="text-success" />
                      {:else if step.result.code === 'superseded' || step.result.code === 'cancelled'}<Ban size={11} class="text-text-muted" />
                      {:else}<X size={11} class="text-error" />{/if}
                    </span>
                    <span class="ui-helper min-w-0 flex-1 whitespace-normal">
                      <span class="text-text-secondary">{stepLabel(step)}</span>
                    </span>
                  </li>
                {/each}
              </ul>
              <details class="ask-details mt-1">
                <summary class="ui-helper cursor-pointer select-none text-text-faint">Details</summary>
                <button class="ui-meta mt-1 rounded px-1.5 py-0.5 text-text-secondary hover:bg-hover hover:text-text-primary" onclick={() => copyTrace(turn)}>{copied === turn.id ? 'Copied full trace' : 'Copy full trace'}</button>
                {#each turn.steps as step, i (step.id)}
                  <details class="mt-1">
                    <summary class="ui-helper cursor-pointer select-none font-mono text-[10px] text-text-faint">{i + 1}. {step.name === 'invokeCapability' && step.input && typeof step.input === 'object' ? String((step.input as Record<string, unknown>).id) : step.name} · {!step.result ? 'running' : step.result.ok ? 'ok' : step.result.code}</summary>
                    <pre class="ui-helper mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{JSON.stringify({ input: step.input, result: step.result }, null, 1)}</pre>
                  </details>
                {/each}
                {#if turn.notes.length}<pre class="ui-helper mt-1 whitespace-pre-wrap font-mono text-[10px]">model notes: {JSON.stringify(turn.notes)}</pre>{/if}
              </details>
            </details>
          {/if}
        </li>
      {/each}
      {#if ask.turns.length === 0 && help === null}
        <li class="ui-helper whitespace-normal">
          Ask for a place, an object, a mission activity, a time or a layer, e.g. “fly to Jezero and show the available imagery”.
        </li>
      {/if}
    </ol>

    {#if ask.serviceBlocked && ask.turns.at(-1)?.status !== 'error'}<p class="ui-helper mx-3 mb-2 text-warning" role="status">{ask.serviceBlocked}</p>{/if}
    {#if askApproval.pending}
      {@const approval = approvalPresentation(askApproval.pending, etToUtcString)}
      <div class="mx-3 mb-2 rounded border border-border p-2" role="group" aria-label="Approve Ask action">
        <p class="ui-body">{approval.title}</p>
        <p class="ui-helper whitespace-normal">{approval.description}</p>
        <details class="mt-1"><summary class="ui-helper cursor-pointer">Exact parameters</summary><pre class="max-h-40 overflow-auto whitespace-pre-wrap text-[10px]">{approval.exact}</pre></details>
        <div class="mt-2 flex gap-2">
          <button class="ask-btn" onclick={() => answerAskApproval(true)}>Approve once</button>
          <button class="ask-btn" onclick={() => answerAskApproval(false)}>Decline</button>
        </div>
      </div>
    {/if}

    <div class="shrink-0 border-t border-border px-3 py-1.5">
      <button class="ui-helper text-text-secondary hover:text-text-primary" aria-expanded={help !== null}
        disabled={ask.running} onclick={() => { help = help === null ? askHelp() : null; }}>What can I do here?</button>
      {#if help !== null}
        <div class="mt-1 flex max-h-80 flex-col gap-1 overflow-y-auto" aria-label="Scene examples">
          <p class="ui-helper text-text-secondary">Ask can help you</p>
          <p class="ui-helper whitespace-normal text-text-faint">{help.categories.join(' · ')}</p>

          <p class="ui-helper mt-1 text-text-secondary">Try in this scene</p>
          <p class="ui-helper text-text-faint">Choose an example to edit. Send when ready.</p>
          {#each help.examples as example}
            <button class="rounded border border-border px-2 py-1 text-left hover:bg-hover" onclick={() => chooseExample(example)}>
              <span class="ui-body block text-text-primary">{example.label}</span>
              <span class="ui-helper block whitespace-normal text-text-faint">{example.evidence}</span>
            </button>
          {:else}
            <p class="ui-helper text-text-faint">No grounded examples for this selection. Select an object or ask what data is available.</p>
          {/each}
          <p class="ui-helper whitespace-normal text-text-faint">{help.authority}</p>
        </div>
      {/if}
    </div>

    <div class="flex shrink-0 items-end gap-1.5 border-t border-border px-3 py-2">
      <textarea
        bind:this={composer}
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
        <button class="ask-btn" onclick={send} disabled={prompt.trim() === '' || !!ask.serviceBlocked} aria-label="Send request" title="Send (Enter)">
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
