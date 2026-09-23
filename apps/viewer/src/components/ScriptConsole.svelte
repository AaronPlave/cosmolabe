<script lang="ts">
  /**
   * The script console — a lightweight sequence runner over `ViewerControl`
   * (docs/scripting.md), not an embedded IDE.
   *
   * The editor is the execution view: line numbers, a rail on the statement
   * running, finished lines stepped back, a failed or stopped line marked.
   * Below it there is only what the editor cannot show — a status line with
   * real progress (`5 / 17` statements), and problems.
   *
   * Controls follow the Event Finder and the timeline: one dominant action
   * when idle, and Pause / Stop only while something is running.
   *
   * A shell panel rather than a dialog: a dialog's scrim and focus trap would
   * hide the scene the script is driving.
   */
  import { onMount, onDestroy } from 'svelte';
  import { Play, Pause, Square, SkipForward, Camera, ChevronDown, Trash2, Check, X, Loader2 } from 'lucide-svelte';
  import { VERB_LIST, verbUsage, type VerbSpec } from '@cosmolabe/control';
  import * as Popover from '$lib/components/ui/popover';
  import { toolDef } from '../lib/shell.svelte';
  import { getCosmo } from '../lib/loader';
  import { ScriptRunner, IDLE, formatDuration, type RunnerState } from '../lib/script-console';
  // Type-only: the editor module (CodeMirror, ~120 KB gzipped) is loaded when
  // the console first opens, not with the app — most visits never open it.
  import type { ScriptEditorHandle } from '../lib/script-editor';
  import {
    readLibrary, saveToLibrary, deleteFromLibrary, type ProgramLibrary, type ScriptStoreFailure,
  } from '../lib/script-store';
  import { takePendingScript } from '../lib/script-demo.svelte';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let source = $state('');
  let run = $state<RunnerState>(IDLE);
  const runner = new ScriptRunner((s) => { run = s; });

  // State, so the run decorations are re-applied to a new view when the panel
  // body remounts (minimize/restore unmounts it, and the view with it).
  let editor = $state<ScriptEditorHandle | null>(null);

  let programName = $state('');
  let draftName = $state('');
  let programsOpen = $state(false);
  let library = $state<ProgramLibrary>(readLibrary());

  const busy = $derived(run.phase === 'running' || run.phase === 'pausing' || run.phase === 'paused');
  const finished = $derived(run.phase === 'done' || run.phase === 'failed' || run.phase === 'cancelled');

  /** The statement number being run — 1-based — or how many finished. */
  const stepText = $derived.by(() => {
    if (run.total === 0) return '';
    const n = busy && run.activeLine != null ? Math.min(run.completed + 1, run.total) : run.completed;
    return `${n} / ${run.total}`;
  });

  const waitText = $derived(
    run.wait ? `wait ${trimNumber(run.wait.total)} · ${run.wait.remaining.toFixed(1)}s remaining` : null,
  );

  const progress = $derived(run.total > 0 ? run.completed / run.total : 0);

  function trimNumber(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  const CATEGORY_ORDER: readonly VerbSpec['category'][] = ['Scene', 'Camera', 'Time', 'Display', 'Capture', 'Sequencing'];
  const verbGroups = CATEGORY_ORDER
    .map((category) => ({ category, verbs: VERB_LIST.filter((v) => v.category === category) }))
    .filter((g) => g.verbs.length > 0);

  const READ_MESSAGES: Record<ScriptStoreFailure, string> = {
    unavailable: 'Browser storage is unavailable, so programs cannot be saved here.',
    unreadable: 'Saved programs could not be read; saving is disabled so they are not overwritten.',
  };

  const writeMessage = $derived.by(() => {
    const w = library.writeProblem;
    if (!w) return null;
    const what = w.op === 'save' ? `save "${w.name}"` : `delete "${w.name}"`;
    return w.reason === 'unreadable'
      ? `Could not ${what}: saved programs could not be read.`
      : `Could not ${what}: browser storage refused the write (it may be full).`;
  });

  // ── Editor ──

  onMount(() => {
    // A scripted demo from the welcome screen queued its script before the
    // scene loaded; the console mounts once it has, which is when it runs.
    const pending = takePendingScript();
    if (!pending) return;
    source = pending.source;
    editor?.setDoc(source);
    if (pending.autorun) void start();
  });

  /**
   * Mount the editor on its element, and tear it down with it.
   *
   * An action rather than a one-off in `onMount`: the panel body — this
   * element included — unmounts when the panel is minimized, and a restored
   * panel needs a new view built from the current `source`.
   */
  function mountEditor(node: HTMLElement) {
    let handle: ScriptEditorHandle | null = null;
    let destroyed = false;
    void import('../lib/script-editor').then(({ createScriptEditor }) => {
      // The panel may have been minimized or closed while the module loaded.
      if (destroyed) return;
      handle = createScriptEditor(node, {
        doc: source,
        placeholder: 'gotoObject Moon\nsetFrame body-fixed Moon\ndisplayNote "The Moon"',
        getNames: () => {
          const cosmo = getCosmo();
          return { objects: safe(() => cosmo.listObjects()), viewpoints: safe(() => cosmo.listViewpoints()) };
        },
        onChange: (doc) => {
          source = doc;
          // An edit makes the last run's marks and summary describe some other
          // script; the editor has already dropped its decorations.
          if (finished) run = IDLE;
        },
        onRun: () => { if (!busy) void start(); },
      });
      editor = handle;
    });
    return {
      destroy() {
        destroyed = true;
        handle?.destroy();
        if (editor === handle) editor = null;
      },
    };
  }

  // The runner's state, drawn into the editor.
  $effect(() => {
    const r = run;
    if (!editor) return;
    editor.setReadOnly(r.phase === 'running' || r.phase === 'pausing' || r.phase === 'paused');
    editor.setRun({
      lines: r.lines,
      activeLine: r.activeLine,
      activeNote: r.wait ? `${r.wait.remaining.toFixed(1)}s` : null,
    });
  });

  // Closing the console — or anything that unmounts it, loading a catalog
  // included — ends its script immediately. Minimizing does not come through
  // here: it hides the panel body, not this component.
  onDestroy(() => runner.stop('the console closed'));

  function safe(read: () => readonly string[]): readonly string[] {
    try { return read(); } catch { return []; }
  }

  // ── Run controls ──

  async function start() {
    if (busy || source.trim() === '') return;
    try {
      await runner.run(source, getCosmo());
    } catch (err) {
      // Not a script error — a bug in the viewer. The runner has already
      // recorded it as a failure; keep it visible in the devtools too.
      console.error('[Cosmolabe] script runner', err);
    }
  }

  function snapshot() {
    source = getCosmo().snapshot();
    editor?.setDoc(source);
  }

  function goToLine(line: number) {
    const view = editor?.view;
    if (!view || line < 1 || line > view.state.doc.lines) return;
    const pos = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  }

  // ── Programs ──

  function openPrograms(open: boolean) {
    programsOpen = open;
    if (open) {
      library = { ...readLibrary(), writeProblem: library.writeProblem };
      draftName = programName;
    }
  }

  function save() {
    const name = draftName.trim();
    if (!name) return;
    library = saveToLibrary(name, source);
    if (!library.writeProblem) {
      programName = name;
      programsOpen = false;
    }
  }

  function load(name: string) {
    const found = library.programs.find((p) => p.name === name);
    if (!found || busy) return;
    source = found.program.source;
    editor?.setDoc(source);
    programName = name;
    programsOpen = false;
  }

  function remove(name: string) {
    library = deleteFromLibrary(name);
    if (!library.writeProblem && programName === name) programName = '';
  }

  // ── Keys ──

  /**
   * Keys pressed inside the console are the console's.
   *
   * The app's shortcuts would otherwise fire from the console's buttons — `t`
   * toggling trajectories after clicking Run. Escape normally still reaches
   * the shell (it dismisses the top panel), except from inside the editor:
   * there it first closes whatever the editor has open, and otherwise just
   * leaves the editor, so a stray Escape while typing never closes the panel.
   */
  function containKeys(e: KeyboardEvent) {
    if (e.key !== 'Escape') {
      e.stopPropagation();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('.cm-editor')) {
      e.stopPropagation();
      if (!e.defaultPrevented) editor?.view.contentDOM.blur();
    }
  }
</script>

<InstrumentPanel key="script" title="Script" width={toolDef('script').width} {onClose}>
  {#snippet actions()}
    <Popover.Root open={programsOpen} onOpenChange={openPrograms}>
      <Popover.Trigger
        class="ui-meta flex max-w-40 items-center gap-0.5 rounded px-1.5 py-0.5 text-text-secondary hover:bg-hover hover:text-text-primary"
        title="Saved programs"
      >
        <span class="truncate">{programName || 'Untitled'}</span>
        <ChevronDown size={11} class="shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <Popover.Content align="end" sideOffset={6} class="w-64 p-2" onkeydown={(e: KeyboardEvent) => { if (e.key !== 'Escape') e.stopPropagation(); }}>
          {#if library.readProblem}
            <p class="ui-helper mb-1.5 text-warning">{READ_MESSAGES[library.readProblem]}</p>
          {/if}
          <form class="flex items-center gap-1.5" onsubmit={(e) => { e.preventDefault(); save(); }}>
            <input
              bind:value={draftName}
              placeholder="Program name"
              aria-label="Program name"
              class="ui-control min-w-0 flex-1 rounded border border-border bg-surface-3 px-1.5 py-1 text-text-primary outline-none focus-visible:border-accent"
            />
            <button
              type="submit"
              class="ui-control rounded border border-border bg-surface-3 px-2 py-1 text-text-secondary hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={draftName.trim() === '' || library.readProblem != null}
              title={draftName.trim() && draftName.trim() !== programName ? 'Save as a new program' : 'Save'}
            >
              {draftName.trim() && programName && draftName.trim() !== programName ? 'Save as' : 'Save'}
            </button>
          </form>
          {#if writeMessage}
            <p class="ui-helper mt-1.5 text-error" role="alert">{writeMessage}</p>
          {/if}
          {#if library.programs.length > 0}
            <ul class="mt-2 flex max-h-52 flex-col overflow-y-auto border-t border-border pt-1.5">
              {#each library.programs as { name } (name)}
                <li class="group flex items-center gap-1 rounded hover:bg-hover">
                  <button
                    class="ui-body min-w-0 flex-1 truncate px-1.5 py-1 text-left disabled:opacity-50"
                    class:text-text-primary={name !== programName}
                    class:text-accent={name === programName}
                    onclick={() => load(name)}
                    disabled={busy}
                    title="Load into the editor"
                  >
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
          {:else if !library.readProblem}
            <p class="ui-helper mt-2">No saved programs.</p>
          {/if}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/snippet}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="flex flex-col gap-2" onkeydown={containKeys}>
    <div use:mountEditor class="script-editor min-h-32" class:busy></div>

    <!-- Controls: one dominant action idle; Pause/Stop running; Resume/Step/Stop paused.
         Accessible names say "script": the timeline's transport has its own
         Pause, and pausing a script does not pause scene time. -->
    <div class="flex items-center gap-1.5">
      {#if run.phase === 'running' || run.phase === 'pausing'}
        <button
          class="run-btn flex-1"
          onclick={() => runner.pause()}
          disabled={run.phase === 'pausing'}
          aria-label="Pause script"
          title="Pause after the current step"
        >
          {#if run.phase === 'pausing'}<Loader2 size={12} class="animate-spin" /> Pausing…{:else}<Pause size={12} /> Pause{/if}
        </button>
        <button class="run-btn-secondary" onclick={() => runner.stop()} aria-label="Stop script" title="Stop now">
          <Square size={11} /> Stop
        </button>
      {:else if run.phase === 'paused'}
        <button class="run-btn flex-1" onclick={() => runner.resume()} aria-label="Resume script" title="Resume">
          <Play size={12} /> Resume
        </button>
        <button class="run-btn-secondary" onclick={() => runner.step()} aria-label="Step script" title="Run the next step, then pause">
          <SkipForward size={12} /> Step
        </button>
        <button class="run-btn-secondary" onclick={() => runner.stop()} aria-label="Stop script" title="Stop now">
          <Square size={11} /> Stop
        </button>
      {:else}
        <button
          class="run-btn flex-1"
          onclick={start}
          disabled={source.trim() === ''}
          title="Run (Cmd/Ctrl+Enter)"
        >
          <Play size={12} /> {finished ? 'Run again' : 'Run'}
        </button>
        <button
          class="run-btn-secondary"
          onclick={snapshot}
          title="Replace the editor with a script that reproduces the current view"
        >
          <Camera size={12} /> Snapshot
        </button>
      {/if}
    </div>

    {#if run.phase !== 'idle'}
      <div class="flex flex-col gap-1" role="status" aria-label="Script status">
        <div class="ui-meta flex items-center gap-1.5 tabular-nums">
          {#if busy}
            <span class="status-label" class:text-text-primary={run.phase !== 'paused'}>
              {run.phase === 'paused' ? 'Paused' : run.phase === 'pausing' ? 'Pausing after current step' : 'Running'}
            </span>
            <span>· {stepText}</span>
            {#if waitText}<span class="truncate">· {waitText}</span>{/if}
          {:else if run.phase === 'done'}
            <Check size={12} class="text-success" />
            <span class="text-text-primary">Completed</span>
            <span>· {run.total} step{run.total === 1 ? '' : 's'} · {formatDuration(run.elapsedMs)}</span>
            {#if run.captures}<span>· {run.captures} capture{run.captures === 1 ? '' : 's'}</span>{/if}
          {:else if run.phase === 'cancelled'}
            <Square size={10} class="text-warning" />
            <span class="text-text-primary">Stopped</span>
            <span class="truncate">· {stepText}{run.stopReason && run.stopReason !== 'stopped' ? ` · ${run.stopReason}` : ''}</span>
          {:else if run.phase === 'failed'}
            <X size={12} class="text-error" />
            <span class="text-text-primary">
              {run.total === 0 ? `${run.problems.length} problem${run.problems.length === 1 ? '' : 's'} — nothing ran` : 'Failed'}
            </span>
            {#if run.total > 0}<span>· {stepText}</span>{/if}
          {/if}
        </div>
        {#if busy}
          <div class="h-0.5 w-full overflow-hidden rounded bg-surface-3">
            <div class="h-full bg-accent transition-[width] duration-200" style="width: {progress * 100}%"></div>
          </div>
        {/if}
        {#if run.problems.length > 0}
          <ul class="flex flex-col gap-0.5">
            {#each run.problems as problem, i (i)}
              <li>
                <button class="problem flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-hover" onclick={() => goToLine(problem.line)}>
                  <span class="ui-readout w-6 shrink-0 text-right tabular-nums text-text-muted">{problem.line}</span>
                  <span class="ui-helper whitespace-normal text-error">{problem.message}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if writeMessage && !programsOpen}
      <p class="ui-helper text-error" role="alert">{writeMessage}</p>
    {/if}

    <details class="mt-0.5">
      <summary class="ui-section-label cursor-pointer select-none">Verb reference</summary>
      <div class="mt-1 flex flex-col gap-2">
        {#each verbGroups as group (group.category)}
          <div>
            <div class="ui-meta mb-0.5">{group.category}</div>
            {#each group.verbs as verb (verb.name)}
              <div class="leading-relaxed">
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

<style>
  .run-btn,
  .run-btn-secondary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface-3);
    padding: 6px 8px;
    font-size: 11px;
    transition: background-color 120ms, color 120ms;
  }
  .run-btn { color: var(--color-text-primary); }
  .run-btn-secondary { color: var(--color-text-secondary); }
  .run-btn:hover:not(:disabled),
  .run-btn-secondary:hover:not(:disabled) {
    background: var(--color-hover);
    color: var(--color-text-primary);
  }
  .run-btn:disabled,
  .run-btn-secondary:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .status-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
  }
  /* A running script's source is not editable; say so without shouting. */
  .script-editor.busy :global(.cm-content) {
    cursor: default;
  }
</style>
