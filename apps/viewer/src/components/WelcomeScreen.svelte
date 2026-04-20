<script lang="ts">
  import { vs } from "../lib/viewer-state.svelte";
  import Button from "$lib/components/ui/button/button.svelte";

  interface Props {
    onLoadDemo: (name: string) => void;
    onDrop: (dt: DataTransfer) => void;
    onFiles: (files: File[]) => void;
  }

  let { onLoadDemo, onDrop, onFiles }: Props = $props();

  let fileInput: HTMLInputElement;
  let dragging = $state(false);

  const demos = [
    { id: "earth-moon", label: "Earth + Moon" },
    { id: "solar-system", label: "Solar System" },
    { id: "saturn-system", label: "Saturn System" },
    { id: "sensor-demo", label: "Sensor Frustums" },
    { id: "cassini-soi", label: "Cassini Saturn Tour" },
    { id: "lro-moon", label: "LRO at Moon" },
    { id: "europa-clipper", label: "Europa Clipper" },
    { id: "iss", label: "ISS (TLE)" },
    { id: "msl-dingo-gap", label: "MSL Dingo Gap" },
  ];

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragging = true;
  }
  function handleDragLeave() {
    dragging = false;
  }
  function handleDropEvent(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer) onDrop(e.dataTransfer);
  }
  function handleFileInput() {
    if (fileInput.files) onFiles(Array.from(fileInput.files));
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="welcome-bg"
  class:dragging
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDropEvent}
  onclick={() => fileInput?.click()}
>
  <div class="welcome-card" onclick={(e) => e.stopPropagation()}>
    <!-- Title block -->
    <div class="mb-8">
      <h1
        class="text-6xl font-bold tracking-tight text-text-primary leading-none"
      >
        SpiceCraft
      </h1>
      <p class="text-text-secondary mt-3 text-[14px] leading-relaxed max-w-prose">
        3D space mission visualization in the browser. Render trajectories, planetary systems, sensor frustums, and mission events from SPICE kernels, TLE data, or Cosmographia catalogs.
      </p>
    </div>

    <input
      bind:this={fileInput}
      type="file"
      multiple
      accept=".json,.bsp,.tls,.tpc,.xyzv,.tf,.tsc,.ti,.ck,.bc,.bpc,.spk,.pck,.fk"
      class="hidden"
      onchange={handleFileInput}
    />

    {#if vs.showLoading}
      <div class="w-full max-w-80">
        <div class="w-full h-px bg-surface-3 rounded overflow-hidden">
          <div
            class="h-full bg-text-secondary rounded transition-[width] duration-200"
            style="width: {Math.min(100, vs.loadingProgress)}%"
          ></div>
        </div>
        <div class="text-text-muted text-[11px] mt-2">{vs.loadingLabel}</div>
        {#if vs.loadingDetail}
          <div class="text-text-muted text-[11px] opacity-50">
            {vs.loadingDetail}
          </div>
        {/if}
      </div>
    {:else}
      <!-- Demos -->
      <div class="w-full">
        <h2 class="text-[11px] text-text-muted uppercase tracking-widest mb-3">
          Demo Catalog
        </h2>
        <div class="flex flex-col gap-0.5">
          {#each demos as demo}
            <button
              class="text-[13px] text-text-secondary hover:text-text-primary transition-colors cursor-pointer bg-transparent border-none py-1 text-left"
              onclick={(e: MouseEvent) => {
                e.stopPropagation();
                onLoadDemo(demo.id);
              }}
            >
              {demo.label}
            </button>
          {/each}
        </div>
      </div>

      <!-- Drop hint -->
      <div class="mt-8 pt-6 border-t border-border w-full">
        <p class="text-text-muted text-[12px]">
          Drop a catalog folder here, or click to browse files
        </p>
        <p class="text-text-muted text-[11px] mt-1 opacity-40 font-mono">
          .json &middot; .bsp &middot; .tls &middot; .tpc &middot; .tf &middot;
          .ck
        </p>
      </div>
    {/if}
  </div>
</div>

<style>
  .welcome-bg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 100;
    cursor: pointer;
    /* Subtle radial gradient — dark center fading to slightly lighter edge, gives depth */
    background: radial-gradient(
      ellipse 80% 60% at 50% 45%,
      rgba(18, 18, 24, 0.97) 0%,
      rgba(0, 0, 0, 0.99) 100%
    );
    transition: background 0.2s ease;
  }
  .welcome-bg.dragging {
    background: radial-gradient(
      ellipse 80% 60% at 50% 45%,
      rgba(25, 25, 35, 0.98) 0%,
      rgba(0, 0, 0, 1) 100%
    );
  }

  .welcome-card {
    cursor: default;
    max-width: 500px;
    width: 100%;
    padding: 0 2rem;
  }
</style>
