<script lang="ts">
  import {
    vs, togglePlay, reverse, faster, slower,
    stepForward, stepBackward, scrubTo, setTime, cycleCamera,
    zoomScrubber, resetScrubberZoom, setZoomDuration, etToShortDate,
  } from '../lib/viewer-state.svelte';
  import { formatDuration } from '../lib/scrubber-math';
  import { getSpice } from '../lib/loader';
  import { CameraModeName } from '@spicecraft/three';
  import {
    Globe, ChevronsLeft, ChevronLeft, Rewind, Play, Pause,
    ChevronRight, ChevronsRight, Crosshair, Camera, Settings,
    Keyboard, Info, Ruler,
  } from 'lucide-svelte';
  import TimeScrubber from './TimeScrubber.svelte';
  import * as Popover from '$lib/components/ui/popover';
  import Input from '$lib/components/ui/input/input.svelte';
  import Button from '$lib/components/ui/button/button.svelte';

  interface Props {
    onToggleBodyDrawer: () => void;
    onToggleDisplaySettings: () => void;
    onTogglePick: () => void;
    onToggleInfoPanel: () => void;
    onToggleMeasure: () => void;
    pickModeActive: boolean;
    infoPanelActive: boolean;
    measureActive: boolean;
  }

  let { onToggleBodyDrawer, onToggleDisplaySettings, onTogglePick, onToggleInfoPanel, onToggleMeasure, pickModeActive, infoPanelActive, measureActive }: Props = $props();

  let scrubberDragging = $state(false);
  let gotoTimeOpen = $state(false);
  let gotoTimeValue = $state('');
  let gotoTimeError = $state(false);
  let showShortcuts = $state(false);

  // ── Scrubber state ──

  let currentFraction = $derived(
    vs.scrubMax > vs.scrubMin
      ? Math.max(0, Math.min(1, (vs.et - vs.scrubMin) / (vs.scrubMax - vs.scrubMin)))
      : 0.5
  );

  let baseRange = $derived(vs.scrubBaseMax - vs.scrubBaseMin);
  let currentRange = $derived(vs.scrubMax - vs.scrubMin);
  let isZoomed = $derived(baseRange > 0 && currentRange < baseRange * 0.99);

  let viewportStart = $derived(baseRange > 0 ? (vs.scrubMin - vs.scrubBaseMin) / baseRange : 0);
  let viewportEnd = $derived(baseRange > 0 ? (vs.scrubMax - vs.scrubBaseMin) / baseRange : 1);
  let globalPlayhead = $derived(baseRange > 0 ? (vs.et - vs.scrubBaseMin) / baseRange : 0.5);

  let rangeLabel = $derived(isZoomed ? formatDuration(currentRange) : '');
  let startLabel = $derived(isZoomed ? etToShortDate(vs.scrubMin) : etToShortDate(vs.scrubBaseMin));
  let endLabel = $derived(isZoomed ? etToShortDate(vs.scrubMax) : etToShortDate(vs.scrubBaseMax));

  function handleScrub(fraction: number) {
    scrubberDragging = true;
    scrubTo(fraction);
  }

  // ── Go to time ──

  function onGotoOpen(open: boolean) {
    gotoTimeOpen = open;
    if (open) {
      gotoTimeValue = vs.timeText.replace(' UTC', '');
      gotoTimeError = false;
    }
  }

  function goToTime() {
    const spice = getSpice();
    if (!spice) return;
    try {
      setTime(spice.str2et(gotoTimeValue.trim()));
      gotoTimeOpen = false;
    } catch {
      gotoTimeError = true;
      setTimeout(() => gotoTimeError = false, 1500);
    }
  }

  function onGotoKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') goToTime();
  }
</script>

<div class="absolute bottom-3 left-3 right-3 z-20 border border-border rounded-lg bg-black/90 backdrop-blur-md flex flex-col gap-0.5 px-3 py-1.5">
  {#if showShortcuts}
    <div class="text-[12px] text-text-muted text-center py-0.5">
      Space: play &middot; &larr;/&rarr;: step &middot; &uarr;/&darr;: speed &middot; R: reverse &middot; F: fly to &middot; B: bodies &middot; D: display &middot; P: pick &middot; M: camera &middot; Cmd+K: search &middot; \: zen
    </div>
  {/if}

  <div class="flex items-center gap-1.5 w-full">
    <button class="icon-btn" onclick={onToggleBodyDrawer} title="Body list (B)">
      <Globe size={15} />
    </button>

    <div class="flex gap-px shrink-0">
      <button class="icon-btn" onclick={slower} title="Slower (Down)"><ChevronsLeft size={14} /></button>
      <button class="icon-btn" onclick={stepBackward} title="Step back (Left)"><ChevronLeft size={14} /></button>
      <button class="icon-btn" onclick={reverse} title="Reverse (R)"><Rewind fill="currentColor" size={13} /></button>
      <button class="icon-btn bg-surface-3 border border-border mx-0.5 px-2" onclick={togglePlay} title="Play/Pause (Space)">
        {#if vs.playing}<Pause fill="currentColor" size={14} />{:else}<Play fill="currentColor" size={14} />{/if}
      </button>
      <button class="icon-btn" onclick={stepForward} title="Step forward (Right)"><ChevronRight size={14} /></button>
      <button class="icon-btn" onclick={faster} title="Faster (Up)"><ChevronsRight size={14} /></button>
    </div>

    <span class="font-mono text-[11px] text-text-secondary min-w-16 text-center shrink-0">{vs.rateText}</span>

    <TimeScrubber
      fraction={currentFraction}
      onScrub={handleScrub}
      onScrubStart={() => scrubberDragging = true}
      onScrubEnd={() => scrubberDragging = false}
      onZoom={zoomScrubber}
      onResetZoom={resetScrubberZoom}
      onSetZoom={setZoomDuration}
      {startLabel}
      {endLabel}
      {isZoomed}
      {viewportStart}
      {viewportEnd}
      {globalPlayhead}
      {rangeLabel}
    />

    <!-- Time display + go-to-time popover -->
    <Popover.Root bind:open={gotoTimeOpen} onOpenChange={onGotoOpen}>
      <Popover.Trigger class="font-mono text-[12px] text-text-primary shrink-0 px-2 py-0.5 rounded hover:bg-surface-3 transition-colors whitespace-nowrap cursor-pointer">
        {vs.timeText}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} class="w-80 p-3">
          <div class="flex flex-col gap-2">
            <span class="text-[11px] text-muted-foreground">Go to time</span>
            <div class="flex gap-1.5">
              <Input
                bind:value={gotoTimeValue}
                class="font-mono text-[12px] h-8 {gotoTimeError ? 'border-error' : ''}"
                placeholder="e.g. 2004-06-30T12:00:00"
                onkeydown={onGotoKeydown}
                autofocus
              />
              <Button size="sm" onclick={goToTime}>Go</Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>

    {#if vs.cameraMode !== CameraModeName.FREE_ORBIT}
      <span class="font-mono text-[10px] text-text-secondary bg-surface-3 px-1.5 py-0.5 rounded shrink-0 uppercase tracking-wider">{vs.cameraMode}</span>
    {/if}

    <button class="icon-btn" onclick={() => cycleCamera()} title="Camera mode (M)"><Camera size={15} /></button>
    <button class="icon-btn" class:text-accent={pickModeActive} onclick={onTogglePick} title="Pick surface (P)"><Crosshair size={15} /></button>
    <button class="icon-btn" class:text-accent={measureActive} onclick={onToggleMeasure} title="Measure distance"><Ruler size={15} /></button>
    <button class="icon-btn" class:text-accent={infoPanelActive} onclick={onToggleInfoPanel} title="Body info"><Info size={15} /></button>
    <button class="icon-btn" onclick={onToggleDisplaySettings} title="Display settings (D)"><Settings size={15} /></button>
    <button class="icon-btn" class:text-accent={showShortcuts} onclick={() => showShortcuts = !showShortcuts} title="Keyboard shortcuts"><Keyboard size={15} /></button>
  </div>
</div>

<style>
  .icon-btn {
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    transition: color 0.1s, background 0.1s;
  }
  .icon-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
</style>
