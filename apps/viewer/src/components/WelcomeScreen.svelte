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

  type DemoEntry = { id: string; label: string; desc: string };
  type DemoSection = { heading: string; items: DemoEntry[] };

  const sections: DemoSection[] = [
    {
      heading: "No SPICE — loads instantly",
      items: [
        { id: "earth-moon", label: "Earth + Moon", desc: "Keplerian orbits, no kernels" },
        { id: "inner-planets-keplerian", label: "Inner Planets", desc: "Sun → Mars via Keplerian fallback" },
        { id: "iss", label: "ISS (TLE)", desc: "Two-line element propagation around Earth" },
      ],
    },
    {
      heading: "Base library — composable catalogs",
      items: [
        { id: "base/solarsys", label: "Solar System", desc: "All planets via require composition" },
        { id: "base/inner-planets", label: "Inner Planets", desc: "Mercury → Mars + moons, NAIF de440s" },
        { id: "base/outer-planets", label: "Outer Planets", desc: "Jupiter → Neptune + major moons" },
        { id: "base/jupiter-system", label: "Jupiter System", desc: "Jupiter + Galileans (L1 analytical)" },
        { id: "base/saturn-system", label: "Saturn System", desc: "Saturn + rings + major moons (TASS17)" },
        { id: "base/small-bodies", label: "Small Bodies", desc: "Dwarf planets, main belt, NEAs, comet 67P" },
      ],
    },
    {
      heading: "Extended scenes",
      items: [
        { id: "solar-system", label: "Solar System Tour", desc: "Planets + Ceres + sample spacecraft arc" },
        { id: "sensor-demo", label: "Sensor Frustums", desc: "FOV cones from spacecraft instruments" },
      ],
    },
    {
      heading: "Mission demos — full SPICE",
      items: [
        { id: "cassini-soi", label: "Cassini Saturn Tour", desc: "2004 SOI through Enceladus E-2 (~150 MB)" },
        { id: "lro-moon", label: "LRO at the Moon", desc: "Lunar Reconnaissance Orbiter, 2025" },
        { id: "europa-clipper", label: "Europa Clipper", desc: "Jupiter science phase, 2031" },
        { id: "msl-dingo-gap", label: "MSL Curiosity", desc: "Mars surface rover (experimental)" },
      ],
    },
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
        Cosmolabe
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
      <!-- Demos: CSS columns flow sections evenly into 1/2 columns -->
      <div class="demo-columns">
        {#each sections as section}
          <div class="demo-section">
            <h2 class="demo-heading">{section.heading}</h2>
            <div class="flex flex-col gap-0.5">
              {#each section.items as demo}
                <button
                  class="demo-item"
                  onclick={(e: MouseEvent) => {
                    e.stopPropagation();
                    onLoadDemo(demo.id);
                  }}
                >
                  <div class="demo-item-label">{demo.label}</div>
                  <div class="demo-item-desc">{demo.desc}</div>
                </button>
              {/each}
            </div>
          </div>
        {/each}
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
    max-width: 760px;
    width: 100%;
    padding: 0 2rem;
  }

  /* CSS multi-column flows sections evenly without row alignment */
  .demo-columns {
    column-count: 1;
    column-gap: 2.5rem;
  }
  @media (min-width: 640px) {
    .demo-columns {
      column-count: 2;
    }
  }
  .demo-section {
    break-inside: avoid;
    margin-bottom: 1.75rem;
  }
  .demo-section:last-child {
    margin-bottom: 0;
  }

  .demo-heading {
    /* display: inline-flex; */
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid color-mix(in srgb, var(--color-text-muted) 35%, transparent);
  }

  .demo-item {
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-left: -0.75rem;
    margin-right: -0.75rem;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .demo-item:hover {
    background: var(--color-surface-2);
  }
  .demo-item-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text-primary);
    line-height: 1.3;
  }
  .demo-item-desc {
    font-size: 12px;
    color: var(--color-text-secondary);
    line-height: 1.35;
    margin-top: 2px;
  }
</style>
