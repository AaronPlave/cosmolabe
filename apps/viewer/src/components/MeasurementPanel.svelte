<script lang="ts">
  import { Eye, EyeOff, MousePointer2, Trash2 } from 'lucide-svelte';
  import type { SpatialEndpoint, SpatialRelationship } from '@cosmolabe/core';
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import { getUniverse } from '../lib/loader';
  import { addMeasurement, measurements, removeMeasurement, syncMeasurements } from '../lib/spatial-measurements.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();
  let kind = $state<'distance' | 'angle' | 'direction'>('distance');
  let source = $state(''); let vertex = $state(''); let target = $state('');
  const bodies = $derived(getUniverse()?.getAllBodies().map(b => b.name).sort() ?? []);
  function endpoint(slot: 'source' | 'target' | 'vertex', entity: string): SpatialEndpoint | null {
    return measurements.picked[slot] ?? (entity ? { kind: 'entity', bodyName: entity } : null);
  }
  function create() {
    const a = endpoint('source', source), b = endpoint('target', target), v = endpoint('vertex', vertex);
    if (!a || !b || (kind === 'angle' && !v)) return;
    const base = { id: crypto.randomUUID(), source: a, target: b };
    addMeasurement(kind === 'angle' ? { ...base, kind, vertex: v! } : { ...base, kind, showDistance: true });
    measurements.picked = {}; source = ''; target = ''; vertex = '';
  }
  function toggle(item: SpatialRelationship) { item.visible = item.visible === false; syncMeasurements(); }
</script>

<InstrumentPanel key="measure" title="Spatial relationships" width={330} {onClose}>
  <p class="mb-3 text-xs text-text-secondary">3D chord distances resolve in a common world frame and update with simulation time.</p>
  <label class="field"><span>Type</span><select bind:value={kind}><option value="distance">Distance</option><option value="angle">Angle</option><option value="direction">Direction</option></select></label>
  {@render endpointRow('source', 'Source', source, (v) => source = v)}
  {#if kind === 'angle'}{@render endpointRow('vertex', 'Vertex', vertex, (v) => vertex = v)}{/if}
  {@render endpointRow('target', 'Target', target, (v) => target = v)}
  <button class="primary" onclick={create}>Add relationship</button>
  {#if measurements.items.length}<div class="divider"></div>{/if}
  {#each measurements.items as item (item.id)}
    <div class="item"><div><strong>{item.kind}</strong><small>{label(item.source)} → {item.kind === 'angle' ? `${label(item.vertex)} → ` : ''}{label(item.target)}</small></div>
      <button title={item.visible === false ? 'Show' : 'Hide'} onclick={() => toggle(item)}>{#if item.visible === false}<Eye size={14}/>{:else}<EyeOff size={14}/>{/if}</button>
      <button title="Remove" onclick={() => removeMeasurement(item.id)}><Trash2 size={14}/></button></div>
  {/each}
</InstrumentPanel>

{#snippet endpointRow(slot: 'source'|'target'|'vertex', title: string, value: string, set: (v:string)=>void)}
  <label class="field"><span>{title}</span><div class="endpoint"><select value={value} onchange={(e) => { set(e.currentTarget.value); delete measurements.picked[slot]; }}><option value="">Choose entity…</option>{#each bodies as body}<option value={body}>{body}</option>{/each}</select><button class:active={!!measurements.picked[slot]} title="Pick a surface point" onclick={() => measurements.pendingPickSlot = slot}><MousePointer2 size={14}/></button></div></label>
{/snippet}

<script module lang="ts">
  import { endpointLabel, type SpatialEndpoint as Endpoint } from '@cosmolabe/core';
  function label(endpoint: Endpoint) { return endpointLabel(endpoint); }
</script>

<style>
  .field{display:block;margin:8px 0;color:var(--color-text-secondary);font-size:11px}.field>span{display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em}.endpoint{display:flex;gap:5px}select{width:100%;background:var(--color-control);color:var(--color-text-primary);border:1px solid var(--color-chrome-border);border-radius:4px;padding:6px}.endpoint button,.item button{padding:6px;border:1px solid var(--color-chrome-border);border-radius:4px;background:none;color:var(--color-text-secondary)}.endpoint button.active{color:#67d9ff;border-color:#67d9ff}.primary{width:100%;margin-top:8px;padding:7px;border:1px solid #67d9ff;border-radius:4px;background:rgba(103,217,255,.1);color:var(--color-text-primary)}.divider{border-top:1px solid var(--color-chrome-border);margin:14px 0 6px}.item{display:flex;align-items:center;gap:5px;padding:6px 0}.item>div{min-width:0;flex:1}.item strong,.item small{display:block;text-transform:capitalize}.item small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-secondary)}
</style>
