<script lang="ts">
  /**
   * The script console — the text face of `ViewerControl` (docs/scripting.md).
   *
   * A shell panel rather than a dialog: a dialog's scrim and focus trap would
   * hide the scene the script is driving, which is the one thing you want to
   * watch while it runs.
   *
   * Everything it lists is derived. The verb help is `VERB_LIST`, so it cannot
   * advertise a verb the interpreter lacks — the defect class of a shortcut
   * strip that promised a key nothing implemented.
   */
  import { onMount } from 'svelte';
  import { Play, Loader2, Camera, Save, Trash2 } from 'lucide-svelte';
  import { VERB_LIST, verbUsage, type VerbSpec } from '@cosmolabe/control';
  import { toolDef } from '../lib/shell.svelte';
  import { getCosmo } from '../lib/loader';
  import { runWithTranscript, type TranscriptEntry } from '../lib/script-console';
  import {
    listPrograms, saveProgram, deleteProgram, storeProblem, type ScriptStoreFailure,
  } from '../lib/script-store';
  import { takePendingScript } from '../lib/script-demo.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let source = $state('');
  let programName = $state('');
  let running = $state(false);
  let transcript = $state<readonly TranscriptEntry[]>([]);
  let summary = $state<string | null>(null);
  let programs = $state(listPrograms());
  let storeFailure = $state<ScriptStoreFailure | null>(storeProblem());
  let log = $state<HTMLElement | null>(null);

  // Keep the statement that is running in view as the transcript streams.
  $effect(() => {
    void transcript;
    void summary;
    if (log) log.scrollTop = log.scrollHeight;
  });

  const CATEGORY_ORDER: readonly VerbSpec['category'][] = ['Scene', 'Camera', 'Time', 'Display', 'Capture', 'Sequencing'];
  const verbGroups = CATEGORY_ORDER
    .map((category) => ({ category, verbs: VERB_LIST.filter((v) => v.category === category) }))
    .filter((g) => g.verbs.length > 0);

  const STORE_MESSAGES: Record<ScriptStoreFailure, string> = {
    unavailable: 'Browser storage is unavailable, so programs cannot be saved here.',
    unreadable: 'Saved programs could not be read; saving is disabled so they are not overwritten.',
  };

  // A scripted demo from the welcome screen queues its script before the scene
  // has loaded; the console mounts once it has, which is when it should run.
  onMount(() => {
    const pending = takePendingScript();
    if (!pending) return;
    source = pending.source;
    if (pending.autorun) void run();
  });

  async function run() {
    if (running || source.trim() === '') return;
    running = true;
    summary = null;
    try {
      const result = await runWithTranscript(source, getCosmo(), (entries) => { transcript = entries; });
      if (result.ok) {
        const frames = result.images.length;
        summary = `Ran ${result.ran} statement${result.ran === 1 ? '' : 's'}` +
          (frames ? `, captured ${frames} frame${frames === 1 ? '' : 's'}` : '');
      } else {
        summary = result.ran > 0 ? `Stopped after ${result.ran} statement${result.ran === 1 ? '' : 's'}` : 'Nothing ran';
      }
    } catch (err) {
      // Not a script error — a bug in the viewer. Say so rather than swallow it.
      summary = `Internal error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      running = false;
    }
  }

  function snapshot() {
    source = getCosmo().snapshot();
  }

  function refreshPrograms() {
    programs = listPrograms();
    storeFailure = storeProblem();
  }

  function save() {
    const name = programName.trim();
    if (!name) return;
    storeFailure = saveProgram(name, source);
    refreshPrograms();
  }

  function load(name: string) {
    const found = programs.find((p) => p.name === name);
    if (!found) return;
    source = found.program.source;
    programName = name;
  }

  function remove(name: string) {
    storeFailure = deleteProgram(name);
    refreshPrograms();
  }

  function onEditorKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  }

  /**
   * Keys pressed inside the console are the console's.
   *
   * The app's input guard covers the text fields but not the buttons, and focus
   * legitimately sits on those here: without this, pressing `t` after clicking
   * Run would toggle trajectories, and `b` would open the catalog. Escape still
   * goes through — dismissing the top panel is a shell rule, not a shortcut.
   */
  function containKeys(e: KeyboardEvent) {
    if (e.key !== 'Escape') e.stopPropagation();
  }
</script>

<InstrumentPanel key="script" title="Script" width={toolDef('script').width} {onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="flex flex-col gap-2" onkeydown={containKeys}>
    <textarea
      bind:value={source}
      onkeydown={onEditorKeydown}
      spellcheck="false"
      wrap="off"
      rows="8"
      placeholder={'gotoObject Titan\nsetFrame body-fixed Titan\ndisplayNote "Titan"'}
      aria-label="Script source"
      class="ui-control min-h-32 w-full resize-y overflow-x-auto whitespace-pre rounded border border-border bg-surface-3 px-2 py-1.5 font-mono text-text-primary outline-none focus-visible:border-accent"
    ></textarea>

    <div class="flex items-center gap-1.5">
      <button
        class="ui-control flex flex-1 items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-2 py-1.5 text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        onclick={run}
        disabled={running || source.trim() === ''}
        title="Run (Cmd/Ctrl+Enter)"
      >
        {#if running}<Loader2 size={12} class="animate-spin" /> Running…{:else}<Play size={12} /> Run{/if}
      </button>
      <button
        class="ui-control flex items-center justify-center gap-1.5 rounded border border-border bg-surface-3 px-2 py-1.5 text-text-secondary hover:bg-hover hover:text-text-primary disabled:opacity-50"
        onclick={snapshot}
        disabled={running}
        title="Replace the editor with a script that reproduces the current view"
      >
        <Camera size={12} /> Snapshot
      </button>
    </div>

    {#if transcript.length > 0 || summary}
      <div bind:this={log} class="max-h-56 overflow-y-auto rounded border border-border bg-surface-1 py-1" role="log" aria-live="polite">
        {#each transcript as entry, i (i)}
          <div class="flex gap-2 px-2 leading-relaxed">
            <span class="ui-readout w-6 shrink-0 text-right tabular-nums text-text-muted">{entry.line}</span>
            <div class="min-w-0 flex-1">
              <div
                class="truncate font-mono"
                class:text-text-secondary={entry.status === 'ok'}
                class:text-text-primary={entry.status === 'running'}
                class:text-error={entry.status === 'error'}
                title={entry.text}
              >
                {entry.text.trim()}
              </div>
              {#if entry.message}
                <div class="ui-helper whitespace-normal text-error">{entry.message}</div>
              {/if}
            </div>
          </div>
        {/each}
        {#if summary}
          <div class="ui-meta px-2 pt-0.5">{summary}</div>
        {/if}
      </div>
    {/if}

    <div class="shell-divider border-t"></div>

    <div class="ui-section-label">Programs</div>
    {#if storeFailure}
      <p class="ui-helper text-warning">{STORE_MESSAGES[storeFailure]}</p>
    {/if}
    <div class="flex items-center gap-1.5">
      <input
        bind:value={programName}
        placeholder="Program name"
        aria-label="Program name"
        class="ui-control min-w-0 flex-1 rounded border border-border bg-surface-3 px-1.5 py-1 text-text-primary outline-none focus-visible:border-accent"
        onkeydown={(e) => { if (e.key === 'Enter') save(); }}
      />
      <button
        class="ui-control flex items-center gap-1 rounded border border-border bg-surface-3 px-2 py-1 text-text-secondary hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        onclick={save}
        disabled={programName.trim() === '' || storeFailure != null}
        title="Save the editor under this name"
      >
        <Save size={12} /> Save
      </button>
    </div>
    {#if programs.length > 0}
      <ul class="flex flex-col">
        {#each programs as { name } (name)}
          <li class="group flex items-center gap-1 rounded hover:bg-hover">
            <button class="ui-body min-w-0 flex-1 truncate px-1.5 py-1 text-left text-text-primary" onclick={() => load(name)} title="Load into the editor">
              {name}
            </button>
            <button
              class="px-1.5 py-1 text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-error"
              onclick={() => remove(name)}
              aria-label={`Delete ${name}`}
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </li>
        {/each}
      </ul>
    {:else if !storeFailure}
      <p class="ui-helper">No saved programs.</p>
    {/if}

    <details class="mt-1">
      <summary class="ui-section-label cursor-pointer select-none">Verbs</summary>
      <div class="mt-1 flex flex-col gap-2">
        {#each verbGroups as group (group.category)}
          <div>
            <div class="ui-meta mb-0.5">{group.category}</div>
            {#each group.verbs as verb (verb.name)}
              <div class="leading-relaxed" title={verb.help}>
                <span class="font-mono text-text-primary">{verbUsage(verb)}</span>
                <div class="ui-helper whitespace-normal">{verb.help}</div>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </details>
  </div>
</InstrumentPanel>
