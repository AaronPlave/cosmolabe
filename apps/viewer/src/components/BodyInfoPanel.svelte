<script lang="ts">
  import { vs, selectBody, getRenderer } from '../lib/viewer-state.svelte';
  import type { InfoRow, InfoSectionResult } from '@cosmolabe/three';
  import { X, Navigation } from 'lucide-svelte';

  let bodyEntry = $derived(vs.bodies.find(b => b.name === vs.selectedBodyName));

  // Compute live distance from camera (re-derives each frame via vs.et)
  let distance = $derived.by(() => {
    void vs.et; // trigger reactivity each frame
    const r = getRenderer();
    if (!r || !vs.selectedBodyName) return null;
    const bm = r.getBodyMesh(vs.selectedBodyName);
    if (!bm) return null;
    return r.camera.position.distanceTo(bm.position) / r.scaleFactor;
  });

  // Altitude above the body's surface at the lat under the camera. Uses the
  // body's IAU oblate radius — `displayRadius` is the equatorial value, and
  // would give wildly wrong altitudes near the poles of a flattened body
  // (Mars: ~20 km gap, Earth: ~21 km gap).
  let altitude = $derived.by(() => {
    void vs.et;
    const r = getRenderer();
    if (!r || !vs.selectedBodyName || distance == null) return null;
    const bm = r.getBodyMesh(vs.selectedBodyName);
    if (!bm) return null;
    // Convert camera position into the body's body-fixed frame to find the
    // subpoint latitude.
    const toCam = r.camera.position.clone().sub(bm.position);
    const bf = toCam.divideScalar(r.scaleFactor).applyQuaternion(bm.mesh.quaternion.clone().invert());
    const len = bf.length();
    if (len < 1e-10) return null;
    const latDeg = Math.asin(Math.max(-1, Math.min(1, bf.y / len))) * (180 / Math.PI);
    return distance - bm.surfaceRadiusAtLat(latDeg);
  });

  // Body's altitude above the parent body's surface in two flavors:
  // - aboveTerrain: sampled at the body's CURRENT lat/lon on the parent's
  //   rendered terrain. Null if the parent has no terrain, or no tile yet
  //   covers that lat/lon (angularDistDeg > 1° from any loaded vertex).
  // - aboveRef: distance from parent's center minus parent's reference
  //   radius (IAU mean). Always defined when a parent exists. Less useful
  //   visually (negative numbers below sea level) but a deterministic fallback.
  let bodyAltitudes = $derived.by((): { aboveTerrain: number | null; aboveRef: number | null; parentBmName: string | null } => {
    void vs.et;
    void vs.frameTick;
    const r = getRenderer();
    if (!r || !vs.selectedBodyName) return { aboveTerrain: null, aboveRef: null, parentBmName: null };
    const bm = r.getBodyMesh(vs.selectedBodyName);
    if (!bm || !bm.body.parentName) return { aboveTerrain: null, aboveRef: null, parentBmName: null };
    const parentBm = r.getBodyMesh(bm.body.parentName);
    if (!parentBm) return { aboveTerrain: null, aboveRef: null, parentBmName: null };
    const dist = bm.position.distanceTo(parentBm.position) / r.scaleFactor;
    // Compute the subpoint latitude on the parent body so radii (sphere or
    // oblate) work correctly for both readouts.
    const toBody = bm.position.clone().sub(parentBm.position);
    const invQ = parentBm.mesh.quaternion.clone().invert();
    const bf = toBody.clone().divideScalar(r.scaleFactor).applyQuaternion(invQ);
    const ecefX = bf.x, ecefY = -bf.z, ecefZ = bf.y;
    const rr = Math.sqrt(ecefX * ecefX + ecefY * ecefY + ecefZ * ecefZ);
    const latDeg = rr > 1e-10
      ? Math.asin(Math.max(-1, Math.min(1, ecefZ / rr))) * (180 / Math.PI)
      : 0;
    const lonDeg = Math.atan2(ecefY, ecefX) * (180 / Math.PI);
    const refRadius = parentBm.surfaceRadiusAtLat(latDeg);
    const aboveRef = dist - refRadius;

    let aboveTerrain: number | null = null;
    if (parentBm.hasTerrain && rr > 1e-10) {
      const sample = parentBm.sampleTerrainElevation(latDeg, lonDeg);
      if (sample && sample.angularDistDeg < 1.0) {
        // sample.elevationKm = closestRadiusKm - displayRadius (see
        // TerrainManager.sampleElevationKm). So the absolute terrain radius
        // at the sampled vertex is displayRadius + elevationKm.
        aboveTerrain = dist - (parentBm.displayRadius + sample.elevationKm);
      }
    }
    return { aboveTerrain, aboveRef, parentBmName: bm.body.parentName };
  });

  // Compute live state vector
  let stateInfo = $derived.by(() => {
    void vs.et;
    const r = getRenderer();
    if (!r || !vs.selectedBodyName) return null;
    const bm = r.getBodyMesh(vs.selectedBodyName);
    if (!bm) return null;
    const state = bm.body.stateAt(vs.et);
    if (!state) return null;
    const [x, y, z] = state.position;
    const [vx, vy, vz] = state.velocity;
    const range = Math.sqrt(x * x + y * y + z * z);
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    return { range, speed };
  });

  // SPE angle (Sun-Probe-Earth) — comm geometry, independent of target body
  let speAngle = $derived.by(() => {
    void vs.et;
    const r = getRenderer();
    if (!r || !vs.selectedBodyName) return null;
    try {
      const universe = r.getContext().universe;
      const probePos = universe.absolutePositionOf(vs.selectedBodyName, vs.et);
      const sunPos = universe.absolutePositionOf('Sun', vs.et);
      const earthPos = universe.absolutePositionOf('Earth', vs.et);
      if (isNaN(probePos[0]) || isNaN(sunPos[0]) || isNaN(earthPos[0])) return null;
      // Don't show SPE if the selected body IS Earth or Sun
      if (vs.selectedBodyName === 'Earth' || vs.selectedBodyName === 'Sun') return null;
      const psX = sunPos[0] - probePos[0], psY = sunPos[1] - probePos[1], psZ = sunPos[2] - probePos[2];
      const peX = earthPos[0] - probePos[0], peY = earthPos[1] - probePos[1], peZ = earthPos[2] - probePos[2];
      const dot = psX * peX + psY * peY + psZ * peZ;
      const magPS = Math.sqrt(psX * psX + psY * psY + psZ * psZ);
      const magPE = Math.sqrt(peX * peX + peY * peY + peZ * peZ);
      if (magPS <= 0 || magPE <= 0) return null;
      return Math.acos(Math.max(-1, Math.min(1, dot / (magPS * magPE)))) * (180 / Math.PI);
    } catch { return null; }
  });

  interface ResolvedSection {
    id: string;
    label: string;
    rows?: InfoRow[];
    html?: string;
  }

  // Collect plugin info sections for the selected body
  let pluginSections = $derived.by((): ResolvedSection[] => {
    void vs.et;
    const r = getRenderer();
    if (!r || !vs.selectedBodyName) return [];
    const bm = r.getBodyMesh(vs.selectedBodyName);
    if (!bm) return [];
    const ctx = r.getContext();
    const sections: ResolvedSection[] = [];
    for (const plugin of r.getPlugins()) {
      if (!plugin.ui?.infoSections) continue;
      for (const sec of plugin.ui.infoSections) {
        const result = sec.render(bm.body, vs.et, ctx);
        if (result == null) continue;
        if (typeof result === 'object' && 'rows' in result) {
          sections.push({ id: sec.id, label: sec.label, rows: result.rows });
        } else if (typeof result === 'string') {
          sections.push({ id: sec.id, label: sec.label, html: result });
        } else {
          sections.push({ id: sec.id, label: sec.label, html: result.outerHTML });
        }
      }
    }
    return sections;
  });

  function formatDist(km: number | null): string {
    if (km == null) return '--';
    if (km < 1) return `${(km * 1000).toFixed(0)} m`;
    if (km < 1000) return `${km.toFixed(1)} km`;
    if (km < 1e6) return `${(km / 1000).toFixed(1)}K km`;
    if (km < 1e9) return `${(km / 1e6).toFixed(2)}M km`;
    return `${(km / 1.496e8).toFixed(3)} AU`;
  }

  function formatSpeed(kms: number): string {
    if (kms < 1) return `${(kms * 1000).toFixed(1)} m/s`;
    return `${kms.toFixed(2)} km/s`;
  }

  function flyTo() {
    const r = getRenderer();
    if (!r || !vs.selectedBodyName) return;
    const bm = r.getBodyMesh(vs.selectedBodyName);
    if (bm) r.cameraController.flyTo(bm, { scaleFactor: r.scaleFactor });
  }
</script>

{#if vs.selectedBodyName}
  <div class="absolute top-3 right-3 z-15 bg-black/90 backdrop-blur-md border border-border rounded-lg p-3 min-w-52 max-w-72 text-[12px] animate-fade-in">
    <!-- Header -->
    <div class="flex items-center gap-1.5 mb-1">
      <span class="text-[14px] font-semibold text-text-primary flex-1">{vs.selectedBodyName}</span>
      <button class="bg-transparent border-none text-text-muted cursor-pointer p-0.5 rounded hover:text-text-primary transition-colors" onclick={flyTo} title="Fly to">
        <Navigation size={13} />
      </button>
      <button class="bg-transparent border-none text-text-muted cursor-pointer p-0.5 rounded hover:text-text-primary transition-colors" onclick={() => selectBody(null)}>
        <X size={13} />
      </button>
    </div>

    {#if bodyEntry?.classification}
      <div class="text-[10px] text-text-muted uppercase tracking-wider mb-2">{bodyEntry.classification}</div>
    {/if}

    <!-- VIEW: camera-relative -->
    <div class="text-[10px] text-text-muted uppercase tracking-wider mt-1 mb-1">View</div>
    <div class="flex flex-col gap-0.5">
      <div class="flex justify-between gap-3">
        <span class="text-text-muted">Range</span>
        <span class="font-mono text-text-primary">{formatDist(distance)}</span>
      </div>
      {#if altitude != null}
        <div class="flex justify-between gap-3">
          <span class="text-text-muted">Cam alt</span>
          <span class="font-mono text-text-primary">{formatDist(altitude)}</span>
        </div>
      {/if}
    </div>

    <!-- BODY: this body's height above its parent's surface (terrain primary, ref fallback) -->
    {#if bodyAltitudes.aboveTerrain != null || bodyAltitudes.aboveRef != null}
      <div class="text-[10px] text-text-muted uppercase tracking-wider mt-2 mb-1 pt-2 border-t border-border">Body</div>
      <div class="flex flex-col gap-0.5">
        {#if bodyAltitudes.aboveTerrain != null}
          <div class="flex justify-between gap-3">
            <span class="text-text-muted">Above terrain</span>
            <span class="font-mono text-text-primary">{formatDist(bodyAltitudes.aboveTerrain)}</span>
          </div>
        {:else if bodyAltitudes.aboveRef != null}
          <div class="flex justify-between gap-3">
            <span class="text-text-muted">Above ref</span>
            <span class="font-mono text-text-primary">{formatDist(bodyAltitudes.aboveRef)}</span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ORBIT: this body's motion relative to its parent -->
    {#if stateInfo && bodyAltitudes.parentBmName}
      <div class="text-[10px] text-text-muted uppercase tracking-wider mt-2 mb-1 pt-2 border-t border-border">Orbit</div>
      <div class="flex flex-col gap-0.5">
        <div class="flex justify-between gap-3">
          <span class="text-text-muted">{bodyAltitudes.parentBmName} distance</span>
          <span class="font-mono text-text-primary">{formatDist(stateInfo.range)}</span>
        </div>
        <div class="flex justify-between gap-3">
          <span class="text-text-muted">Speed</span>
          <span class="font-mono text-text-primary">{formatSpeed(stateInfo.speed)}</span>
        </div>
      </div>
    {/if}

    {#if speAngle != null}
      <div class="flex justify-between gap-3 mt-2 pt-2 border-t border-border">
        <span class="text-text-muted">SPE angle</span>
        <span class="font-mono {speAngle < 5 ? 'text-warning' : 'text-text-primary'}">{speAngle.toFixed(1)}&deg;</span>
      </div>
    {/if}

    <!-- Plugin-contributed info sections -->
    {#each pluginSections as section (section.id)}
      <div class="mt-2 pt-2 border-t border-border">
        <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">{section.label}</div>
        {#if section.rows}
          <div class="flex flex-col gap-0.5">
            {#each section.rows as row}
              <div class="flex justify-between gap-3">
                <span class="text-text-muted">{row.label}</span>
                <span class="font-mono text-text-primary">{row.value}{#if row.unit}<span class="text-text-muted">{row.unit}</span>{/if}</span>
              </div>
            {/each}
          </div>
        {:else if section.html}
          <div class="text-text-primary">{@html section.html}</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  @keyframes fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-fade-in { animation: fade-in 0.12s ease; }
</style>
