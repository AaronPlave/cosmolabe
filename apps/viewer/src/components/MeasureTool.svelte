<script lang="ts">
  import { vs, getRenderer, setTime } from '../lib/viewer-state.svelte';
  import { X, ZoomIn, ZoomOut } from 'lucide-svelte';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let fromOverride = $state<string | null>(null); // null = follow tracked body
  let targetBodyName = $state('');

  // Effective "from" body — follows tracking unless overridden
  let fromBodyName = $derived(fromOverride ?? vs.trackedBodyName);
  let isFromTracked = $derived(fromOverride == null || fromOverride === vs.trackedBodyName);

  const NUM_SAMPLES = 120;
  const ZOOM_LEVELS = [1, 2, 4, 10, 20, 50, 100, 200, 500, 1000, 5000, 10000, 50000, 100000];
  let zoomIndex = $state(0);
  let zoomLevel = $derived(ZOOM_LEVELS[zoomIndex]);

  // Fixed window that only shifts when playhead nears the edge
  let windowStart = $state(0);
  let windowEnd = $state(0);

  function windowSpan(): number {
    return (vs.scrubMax - vs.scrubMin) / zoomLevel;
  }

  /** Recenter window on current ET */
  function recenterWindow() {
    const span = windowSpan();
    const halfSpan = span / 2;
    let start = vs.et - halfSpan;
    start = Math.max(vs.scrubMin, Math.min(start, vs.scrubMax - span));
    windowStart = start;
    windowEnd = start + span;
  }

  function zoomIn() {
    if (zoomIndex < ZOOM_LEVELS.length - 1) zoomIndex++;
    recenterWindow();
  }
  function zoomOut() {
    if (zoomIndex > 0) zoomIndex--;
    recenterWindow();
  }

  // Initialize window on first load
  $effect(() => {
    if (vs.scrubMax > vs.scrubMin && windowEnd <= windowStart) {
      recenterWindow();
    }
  });

  // Shift window when playhead reaches near the edge (80% threshold)
  $effect(() => {
    void vs.et;
    const span = windowEnd - windowStart;
    if (span <= 0) return;
    const frac = (vs.et - windowStart) / span;
    if (frac > 0.85 || frac < 0.15) {
      recenterWindow();
    }
  });

  interface ProfilePoint {
    et: number;
    distKm: number;
    relSpeed: number | null;
    rangeRate: number | null;
    phaseAngleDeg: number | null;
  }

  // Precompute the full profile across the scrubber range using absolute positions
  // (walks parent chain so bodies in different reference frames are comparable)
  let profile = $derived.by((): ProfilePoint[] => {
    const r = getRenderer();
    if (!r || !fromBodyName || !targetBodyName) return [];
    if (fromBodyName === targetBodyName) return [];
    if (windowEnd <= windowStart) return [];

    const universe = r.getContext().universe;
    const points: ProfilePoint[] = [];
    const step = (windowEnd - windowStart) / (NUM_SAMPLES - 1);

    for (let i = 0; i < NUM_SAMPLES; i++) {
      const et = windowStart + i * step;
      try {
        const fromPos = universe.absolutePositionOf(fromBodyName, et);
        const toPos = universe.absolutePositionOf(targetBodyName, et);
        if (isNaN(fromPos[0]) || isNaN(toPos[0])) continue;

        const dx = toPos[0] - fromPos[0];
        const dy = toPos[1] - fromPos[1];
        const dz = toPos[2] - fromPos[2];
        const distKm = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Numerical velocity via central difference (±0.5s)
        const dt = 0.5;
        const fromPosA = universe.absolutePositionOf(fromBodyName, et - dt);
        const fromPosB = universe.absolutePositionOf(fromBodyName, et + dt);
        const toPosA = universe.absolutePositionOf(targetBodyName, et - dt);
        const toPosB = universe.absolutePositionOf(targetBodyName, et + dt);

        if (isNaN(fromPosA[0]) || isNaN(toPosB[0])) {
          points.push({ et, distKm, relSpeed: null, rangeRate: null, phaseAngleDeg: null });
          continue;
        }

        // Relative velocity via finite difference of relative position
        const dxA = toPosA[0] - fromPosA[0], dyA = toPosA[1] - fromPosA[1], dzA = toPosA[2] - fromPosA[2];
        const dxB = toPosB[0] - fromPosB[0], dyB = toPosB[1] - fromPosB[1], dzB = toPosB[2] - fromPosB[2];
        const dvx = (dxB - dxA) / (2 * dt);
        const dvy = (dyB - dyA) / (2 * dt);
        const dvz = (dzB - dzA) / (2 * dt);
        const relSpeed = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
        const rangeRate = distKm > 0 ? (dx * dvx + dy * dvy + dz * dvz) / distKm : null;

        // Phase angle: Sun-Target-Observer (angle at target between sun and observer)
        let phaseAngleDeg: number | null = null;
        try {
          const sunPos = universe.absolutePositionOf('Sun', et);
          if (!isNaN(sunPos[0])) {
            // Sun→Target vector
            const stx = toPos[0] - sunPos[0], sty = toPos[1] - sunPos[1], stz = toPos[2] - sunPos[2];
            // Observer→Target vector (from observer to target, same direction as dx,dy,dz but from target's perspective we want target→observer)
            // Phase angle = angle at target between sun direction and observer direction
            // So: vectors FROM target TO sun, and FROM target TO observer
            const tsX = sunPos[0] - toPos[0], tsY = sunPos[1] - toPos[1], tsZ = sunPos[2] - toPos[2];
            const toX = fromPos[0] - toPos[0], toY = fromPos[1] - toPos[1], toZ = fromPos[2] - toPos[2];
            const dot = tsX * toX + tsY * toY + tsZ * toZ;
            const magTS = Math.sqrt(tsX * tsX + tsY * tsY + tsZ * tsZ);
            const magTO = Math.sqrt(toX * toX + toY * toY + toZ * toZ);
            if (magTS > 0 && magTO > 0) {
              phaseAngleDeg = Math.acos(Math.max(-1, Math.min(1, dot / (magTS * magTO)))) * (180 / Math.PI);
            }
          }
        } catch {}

        points.push({ et, distKm, relSpeed, rangeRate, phaseAngleDeg });
      } catch {
        // Coverage gap — skip
      }
    }
    return points;
  });

  // Current values at the playhead — uses absolutePositionOf (same as profile)
  // to avoid reference frame mismatches between bodies with different parents
  let current = $derived.by(() => {
    void vs.et;
    const r = getRenderer();
    if (!r || !fromBodyName || !targetBodyName) return null;

    const universe = r.getContext().universe;
    let distKm = 0;
    let relSpeed: number | null = null;
    let rangeRate: number | null = null;

    try {
      const fromPos = universe.absolutePositionOf(fromBodyName, vs.et);
      const toPos = universe.absolutePositionOf(targetBodyName, vs.et);
      if (isNaN(fromPos[0]) || isNaN(toPos[0])) return null;

      const dx = toPos[0] - fromPos[0], dy = toPos[1] - fromPos[1], dz = toPos[2] - fromPos[2];
      distKm = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Velocity via finite difference (same method as profile)
      const dt = 0.5;
      const fromPosA = universe.absolutePositionOf(fromBodyName, vs.et - dt);
      const fromPosB = universe.absolutePositionOf(fromBodyName, vs.et + dt);
      const toPosA = universe.absolutePositionOf(targetBodyName, vs.et - dt);
      const toPosB = universe.absolutePositionOf(targetBodyName, vs.et + dt);

      if (!isNaN(fromPosA[0]) && !isNaN(toPosB[0])) {
        const dxA = toPosA[0] - fromPosA[0], dyA = toPosA[1] - fromPosA[1], dzA = toPosA[2] - fromPosA[2];
        const dxB = toPosB[0] - fromPosB[0], dyB = toPosB[1] - fromPosB[1], dzB = toPosB[2] - fromPosB[2];
        const dvx = (dxB - dxA) / (2 * dt), dvy = (dyB - dyA) / (2 * dt), dvz = (dzB - dzA) / (2 * dt);
        relSpeed = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
        if (distKm > 0) {
          rangeRate = (dx * dvx + dy * dvy + dz * dvz) / distKm;
        }
      }
    } catch { return null; }

    // Phase angle (live)
    let phaseAngleDeg: number | null = null;
    try {
      const sunPos = universe.absolutePositionOf('Sun', vs.et);
      const obsPos = universe.absolutePositionOf(fromBodyName!, vs.et);
      const tgtPos = universe.absolutePositionOf(targetBodyName, vs.et);
      if (!isNaN(sunPos[0]) && !isNaN(obsPos[0]) && !isNaN(tgtPos[0])) {
        const tsX = sunPos[0] - tgtPos[0], tsY = sunPos[1] - tgtPos[1], tsZ = sunPos[2] - tgtPos[2];
        const toX = obsPos[0] - tgtPos[0], toY = obsPos[1] - tgtPos[1], toZ = obsPos[2] - tgtPos[2];
        const dot = tsX * toX + tsY * toY + tsZ * toZ;
        const magTS = Math.sqrt(tsX * tsX + tsY * tsY + tsZ * tsZ);
        const magTO = Math.sqrt(toX * toX + toY * toY + toZ * toZ);
        if (magTS > 0 && magTO > 0) {
          phaseAngleDeg = Math.acos(Math.max(-1, Math.min(1, dot / (magTS * magTO)))) * (180 / Math.PI);
        }
      }
    } catch {}

    return { distKm, relSpeed, rangeRate, phaseAngleDeg };
  });

  // Current time position as fraction 0-1 within the visible window
  let playheadFrac = $derived(
    windowEnd > windowStart
      ? Math.max(0, Math.min(1, (vs.et - windowStart) / (windowEnd - windowStart)))
      : 0.5
  );

  const W = 200;
  const H = 28;

  function buildPolyline(
    points: ProfilePoint[],
    getValue: (p: ProfilePoint) => number | null,
    symmetric: boolean,
  ): { line: string; min: number; max: number } {
    const vals = points.map(getValue).filter((v): v is number => v != null);
    if (vals.length === 0) return { line: '', min: 0, max: 0 };

    let min: number, max: number;
    if (symmetric) {
      const absMax = Math.max(...vals.map(Math.abs), 1e-10);
      min = -absMax;
      max = absMax;
    } else {
      min = Math.min(...vals);
      max = Math.max(...vals);
    }
    const range = max - min || 1;

    const line = points
      .map((p, i) => {
        const v = getValue(p);
        if (v == null) return null;
        const x = (i / (points.length - 1)) * W;
        const y = H - ((v - min) / range) * (H * 0.85) - H * 0.075;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');

    return { line, min, max };
  }

  let distLine = $derived(buildPolyline(profile, p => p.distKm, false));
  let speedLine = $derived(buildPolyline(profile, p => p.relSpeed, false));
  let rateLine = $derived(buildPolyline(profile, p => p.rangeRate, true));
  let phaseLine = $derived(buildPolyline(profile, p => p.phaseAngleDeg, false));

  // Close approaches — computed once at high resolution across the FULL time range,
  // independent of the zoom window. Cached until the target body changes.
  interface CloseApproachData {
    distKm: number;
    altKm: number | null; // altitude above target body surface
    et: number;
  }

  /**
   * Compute altitude above a triaxial ellipsoid surface.
   * Gets the relative position vector, applies body-fixed rotation if available,
   * then projects onto the ellipsoid to find the surface point distance.
   */
  function ellipsoidAltitude(
    universe: any, fromName: string, toName: string,
    targetBody: any, et: number,
  ): number | null {
    try {
      const fromPos = universe.absolutePositionOf(fromName, et);
      const toPos = universe.absolutePositionOf(toName, et);
      if (isNaN(fromPos[0]) || isNaN(toPos[0])) return null;

      // Relative position: from target body center to spacecraft
      let rx = fromPos[0] - toPos[0];
      let ry = fromPos[1] - toPos[1];
      let rz = fromPos[2] - toPos[2];
      const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (dist < 1e-10) return 0;

      // Try to rotate into body-fixed frame for accurate ellipsoid projection
      const rot = targetBody.rotationAt?.(et);
      if (rot) {
        // Apply inverse quaternion: q* · r · q
        const [qx, qy, qz, qw] = rot;
        // Conjugate quaternion
        const cqx = -qx, cqy = -qy, cqz = -qz, cqw = qw;
        // Rotate vector by conjugate: body-fixed = q* · inertial
        const ix = cqw * rx + cqy * rz - cqz * ry;
        const iy = cqw * ry + cqz * rx - cqx * rz;
        const iz = cqw * rz + cqx * ry - cqy * rx;
        const iw = -cqx * rx - cqy * ry - cqz * rz;
        rx = ix * cqw + iw * (-cqx) + iy * (-cqz) - iz * (-cqy);
        ry = iy * cqw + iw * (-cqy) + iz * (-cqx) - ix * (-cqz);
        rz = iz * cqw + iw * (-cqz) + ix * (-cqy) - iy * (-cqx);
      }

      // Triaxial ellipsoid radii [a, b, c]
      const [ra, rb, rc] = targetBody.radii;

      // Surface point along the direction of r:
      // The point on ellipsoid x²/a² + y²/b² + z²/c² = 1 along direction (rx,ry,rz)
      // is at parameter t where (t*rx/a)² + (t*ry/b)² + (t*rz/c)² = 1
      const s = (rx / ra) ** 2 + (ry / rb) ** 2 + (rz / rc) ** 2;
      if (s < 1e-20) return dist; // degenerate
      const surfaceDist = Math.sqrt((rx * rx + ry * ry + rz * rz) / s);

      return dist - surfaceDist;
    } catch {
      return null;
    }
  }

  /** Compute distance between two bodies at a given ET */
  function distAtEt(universe: any, fromName: string, toName: string, et: number): number | null {
    try {
      const fromPos = universe.absolutePositionOf(fromName, et);
      const toPos = universe.absolutePositionOf(toName, et);
      if (isNaN(fromPos[0]) || isNaN(toPos[0])) return null;
      const dx = toPos[0] - fromPos[0], dy = toPos[1] - fromPos[1], dz = toPos[2] - fromPos[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    } catch { return null; }
  }

  // Two-pass close approach detection:
  // Pass 1: coarse scan (2000 samples) to find approximate minima
  // Pass 2: refine each minimum with 100 samples in a narrow window + golden section search
  const CA_COARSE = 2000;
  const CA_REFINE = 50;

  let allCloseApproaches = $derived.by((): CloseApproachData[] => {
    const r = getRenderer();
    if (!r || !fromBodyName || !targetBodyName) return [];
    if (vs.scrubMax <= vs.scrubMin) return [];

    const universe = r.getContext().universe;
    const fullSpan = vs.scrubMax - vs.scrubMin;
    const coarseStep = fullSpan / (CA_COARSE - 1);

    // Pass 1: coarse scan
    const dists: { et: number; distKm: number }[] = [];
    for (let i = 0; i < CA_COARSE; i++) {
      const et = vs.scrubMin + i * coarseStep;
      const d = distAtEt(universe, fromBodyName!, targetBodyName, et);
      if (d != null) dists.push({ et, distKm: d });
    }

    // Find all coarse local minima
    const coarseMinima: { et: number; distKm: number }[] = [];
    for (let i = 1; i < dists.length - 1; i++) {
      if (dists[i].distKm < dists[i - 1].distKm && dists[i].distKm < dists[i + 1].distKm) {
        coarseMinima.push(dists[i]);
      }
    }

    // Pass 2: refine each minimum with golden section search
    const phi = (1 + Math.sqrt(5)) / 2;
    const approaches: CloseApproachData[] = [];

    for (const cm of coarseMinima) {
      // Search window: ±1 coarse step around the approximate minimum
      let a = cm.et - coarseStep;
      let b = cm.et + coarseStep;
      a = Math.max(a, vs.scrubMin);
      b = Math.min(b, vs.scrubMax);

      // Golden section minimization
      for (let iter = 0; iter < CA_REFINE; iter++) {
        const c = b - (b - a) / phi;
        const d = a + (b - a) / phi;
        const fc = distAtEt(universe, fromBodyName!, targetBodyName, c);
        const fd = distAtEt(universe, fromBodyName!, targetBodyName, d);
        if (fc == null || fd == null) break;
        if (fc < fd) b = d; else a = c;
      }

      const refinedEt = (a + b) / 2;
      const refinedDist = distAtEt(universe, fromBodyName!, targetBodyName, refinedEt);
      if (refinedDist != null) {
        // Compute altitude above target body's ellipsoidal surface
        const targetBody = universe.getBody(targetBodyName);
        const altKm = targetBody?.radii
          ? ellipsoidAltitude(universe, fromBodyName!, targetBodyName, targetBody, refinedEt)
          : null;
        approaches.push({ et: refinedEt, distKm: refinedDist, altKm });
      }
    }

    return approaches;
  });

  // Project close approaches into the current chart window
  interface CloseApproachMarker {
    x: number;
    y: number;
    distKm: number;
    altKm: number | null;
    et: number;
  }

  let closeApproachMarkers = $derived.by((): CloseApproachMarker[] => {
    if (allCloseApproaches.length === 0 || windowEnd <= windowStart) return [];
    const { min, max } = distLine;
    const range = max - min || 1;
    const span = windowEnd - windowStart;

    return allCloseApproaches
      .filter(ca => ca.et >= windowStart && ca.et <= windowEnd)
      .map(ca => ({
        x: ((ca.et - windowStart) / span) * W,
        y: H - ((ca.distKm - min) / range) * (H * 0.85) - H * 0.075,
        altKm: ca.altKm,
        distKm: ca.distKm,
        et: ca.et,
      }));
  });

  // Time range labels for the X-axis
  let windowStartLabel = $derived(fmtTimeShort(windowStart));
  let windowEndLabel = $derived(fmtTimeShort(windowEnd));

  function fmtTimeShort(et: number): string {
    const MAX_SAFE_ET = 7.5e9;
    if (!isFinite(et) || Math.abs(et) > MAX_SAFE_ET) {
      const years = et / 31556952;
      return `J2000${years >= 0 ? '+' : ''}${years.toFixed(1)}y`;
    }
    const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
    const d = new Date(j2000Ms + et * 1000);
    // Show date only at low zoom, date+time at high zoom
    const span = windowEnd - windowStart;
    if (span < 86400 * 2) {
      // Less than 2 days: show time
      return d.toISOString().slice(5, 16).replace('T', ' ');
    }
    return d.toISOString().slice(0, 10);
  }

  function fmtDist(km: number): string {
    const abs = Math.abs(km);
    if (abs < 1) return `${(km * 1000).toFixed(1)} m`;
    if (abs < 1000) return `${km.toFixed(1)} km`;
    if (abs < 1e6) return `${(km / 1000).toFixed(1)}K km`;
    if (abs < 1e9) return `${(km / 1e6).toFixed(2)}M km`;
    return `${(km / 1.496e8).toFixed(3)} AU`;
  }

  function fmtSpeed(kms: number): string {
    if (kms < 0.001) return `${(kms * 1e6).toFixed(1)} mm/s`;
    if (kms < 1) return `${(kms * 1000).toFixed(1)} m/s`;
    return `${kms.toFixed(2)} km/s`;
  }

  // Hover state — shared across all charts
  let hoverFrac = $state<number | null>(null);
  const CA_AUTO_THRESHOLD = 50;
  let showApproaches = $state(true);
  let showApproachTable = $state(false);
  let approachSort = $state<'date' | 'distance'>('distance');

  let sortedApproaches = $derived(
    approachSort === 'distance'
      ? [...allCloseApproaches].sort((a, b) => a.distKm - b.distKm)
      : [...allCloseApproaches].sort((a, b) => a.et - b.et)
  );

  // The profile point nearest to the hover position
  let hoverPoint = $derived.by((): ProfilePoint | null => {
    if (hoverFrac == null || profile.length === 0) return null;
    const idx = Math.round(hoverFrac * (profile.length - 1));
    return profile[Math.max(0, Math.min(idx, profile.length - 1))] ?? null;
  });

  // Hover cursor X position in SVG coords
  let hoverX = $derived(hoverFrac != null ? hoverFrac * W : null);

  // Nearest close approach to hover position (within 5px)
  const CA_SNAP_PX = 5;
  let nearestCA = $derived.by((): CloseApproachMarker | null => {
    if (hoverX == null || !showApproaches) return null;
    let best: CloseApproachMarker | null = null;
    let bestDist = CA_SNAP_PX;
    for (const ca of closeApproachMarkers) {
      const d = Math.abs(ca.x - hoverX);
      if (d < bestDist) {
        bestDist = d;
        best = ca;
      }
    }
    return best;
  });

  function onChartMouseMove(e: MouseEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    hoverFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  let wheelAccum = 0;
  const WHEEL_THRESHOLD = 60;
  function onChartWheel(e: WheelEvent) {
    e.preventDefault();
    wheelAccum += e.deltaY;
    if (Math.abs(wheelAccum) >= WHEEL_THRESHOLD) {
      if (wheelAccum < 0) zoomIn();
      else zoomOut();
      wheelAccum = 0;
    }
  }

  function onChartMouseLeave() {
    hoverFrac = null;
  }

  function onChartClick() {
    // If near a close approach, jump to it; otherwise jump to hover time
    if (nearestCA) {
      setTime(nearestCA.et);
    } else if (hoverPoint) {
      setTime(hoverPoint.et);
    }
  }

  // Display values: hover overrides current
  let displayDist = $derived(hoverPoint?.distKm ?? current?.distKm ?? null);
  let displaySpeed = $derived(hoverPoint?.relSpeed ?? current?.relSpeed ?? null);
  let displayRate = $derived(hoverPoint?.rangeRate ?? current?.rangeRate ?? null);
  let displayPhase = $derived(hoverPoint?.phaseAngleDeg ?? current?.phaseAngleDeg ?? null);

  function fmtAngle(deg: number): string {
    return `${deg.toFixed(1)}°`;
  }

  let availableBodies = $derived(
    vs.bodies.filter(b => b.name !== fromBodyName)
  );
</script>

<div class="absolute top-3 left-3 z-15 bg-black/90 backdrop-blur-md border border-border rounded-lg p-3 min-w-96 text-[12px] animate-fade-in">
  <div class="flex items-center justify-between mb-2">
    <span class="text-text-secondary text-[10px] uppercase tracking-wider font-semibold">Geometry</span>
    <div class="flex items-center gap-0.5">
      <button
        class="bg-transparent border-none cursor-pointer p-0.5 rounded transition-colors {zoomIndex > 0 ? 'text-text-muted hover:text-text-primary' : 'text-text-muted opacity-30'}"
        onclick={zoomOut}
        disabled={zoomIndex === 0}
        title="Zoom out"
      ><ZoomOut size={13} /></button>
      <span class="text-[10px] text-text-muted font-mono min-w-8 text-center">{zoomLevel}x</span>
      <button
        class="bg-transparent border-none cursor-pointer p-0.5 rounded transition-colors {zoomIndex < ZOOM_LEVELS.length - 1 ? 'text-text-muted hover:text-text-primary' : 'text-text-muted opacity-30'}"
        onclick={zoomIn}
        disabled={zoomIndex === ZOOM_LEVELS.length - 1}
        title="Zoom in"
      ><ZoomIn size={13} /></button>
      <button class="bg-transparent border-none text-text-muted cursor-pointer p-0.5 rounded hover:text-text-primary transition-colors ml-1" onclick={onClose}><X size={13} /></button>
    </div>
  </div>

  <!-- From body -->
  <div class="flex items-center gap-5 mb-1.5">
    <span class="text-text-muted text-[11px] w-8">From</span>
    <select
      class="flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 text-[11px] cursor-pointer outline-none"
      value={fromOverride ?? vs.trackedBodyName ?? ''}
      onchange={(e) => {
        const val = (e.target as HTMLSelectElement).value;
        fromOverride = val === vs.trackedBodyName ? null : val || null;
      }}
    >
      <option value="">Select body...</option>
      {#each vs.bodies as body}
        <option value={body.name}>{body.name}{body.name === vs.trackedBodyName ? ' (tracked)' : ''}</option>
      {/each}
    </select>
    {#if fromOverride && fromOverride !== vs.trackedBodyName}
      <button class="ctrl-link shrink-0" onclick={() => fromOverride = null}>reset</button>
    {/if}
  </div>

  <!-- To body -->
  <div class="flex items-center gap-5 mb-2">
    <span class="text-text-muted text-[11px] w-8">To</span>
    <select
      class="flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 text-[11px] cursor-pointer outline-none"
      bind:value={targetBodyName}
    >
      <option value="">Select body...</option>
      {#each availableBodies as body}
        <option value={body.name}>{body.name}</option>
      {/each}
    </select>
  </div>

  <!-- Shared SVG snippet for close approach lines + cursors on any chart -->
  {#snippet chartOverlays()}
    {#if showApproaches}
      {#each closeApproachMarkers as ca}
        <line x1={ca.x} y1="0" x2={ca.x} y2={H}
          stroke="var(--color-success)"
          stroke-width={nearestCA?.et === ca.et ? 2 : 1}
          vector-effect="non-scaling-stroke"
          opacity={nearestCA?.et === ca.et ? 0.9 : 0.3}
        />
      {/each}
    {/if}
    <line x1={playheadFrac * W} y1="0" x2={playheadFrac * W} y2={H} stroke="white" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0.9" />
    {#if hoverX != null}
      <line x1={hoverX} y1="0" x2={hoverX} y2={H} stroke="var(--color-accent)" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0.7" />
    {/if}
  {/snippet}

  <!-- Results -->
  {#if current}
    <div class="flex flex-col gap-2 pt-2 border-t border-border">

      {#snippet metricChart(label: string, value: string, valueClass: string, lineData: { line: string; min: number; max: number }, yFmt: (n: number) => string, zeroline?: boolean)}
        <div>
          <div class="flex justify-between items-baseline mb-1">
            <span class="text-text-secondary text-[12px]">{label}</span>
            <span class="font-mono text-[12px] {valueClass}">{value}</span>
          </div>
          <div class="chart-wrap">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <svg class="chart" class:hoverable={profile.length > 0} viewBox="0 0 {W} {H}" preserveAspectRatio="none"
              onmousemove={onChartMouseMove} onmouseleave={onChartMouseLeave} onclick={onChartClick} onwheel={onChartWheel}>
              {#if zeroline}
                <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--color-border)" stroke-width="1" vector-effect="non-scaling-stroke" />
              {/if}
              <polyline points={lineData.line} fill="none" stroke="var(--color-text-muted)" stroke-width="1" vector-effect="non-scaling-stroke" />
              {@render chartOverlays()}
            </svg>
            <div class="y-range font-mono">{yFmt(lineData.min)} — {yFmt(lineData.max)}</div>
          </div>
        </div>
      {/snippet}

      <!-- Distance -->
      {@render metricChart(
        'Distance',
        displayDist != null ? fmtDist(displayDist) : '—',
        'text-text-primary',
        distLine, fmtDist,
      )}

      <!-- Rel. speed -->
      {#if current.relSpeed != null}
        {@render metricChart(
          'Rel. speed',
          displaySpeed != null ? fmtSpeed(displaySpeed) : '—',
          'text-text-primary',
          speedLine, fmtSpeed,
        )}
      {/if}

      <!-- Range rate -->
      {#if current.rangeRate != null}
        {@render metricChart(
          'Range rate',
          `${(displayRate ?? 0) >= 0 ? '+' : ''}${displayRate != null ? fmtSpeed(Math.abs(displayRate)) : '—'}${(displayRate ?? 0) < 0 ? ' closing' : ' opening'}`,
          (displayRate ?? 0) < 0 ? 'text-success' : 'text-text-primary',
          rateLine, fmtSpeed, true,
        )}
      {/if}

      <!-- Phase angle -->
      {#if displayPhase != null}
        {@render metricChart(
          'Phase angle',
          fmtAngle(displayPhase),
          'text-text-primary',
          phaseLine, fmtAngle,
        )}
      {/if}


      <!-- Time range -->
      <div class="flex justify-between text-[10px] font-mono text-text-muted">
        <span>{windowStartLabel}</span>
        <span>{windowEndLabel}</span>
      </div>

      <!-- Close approaches -->
      {#if allCloseApproaches.length > 0}
        <div class="flex items-center gap-2 pt-1.5 border-t border-border">
          <span class="text-[11px] font-mono flex-1 {showApproaches ? 'text-success' : 'text-text-muted'}">
            {#if nearestCA && showApproaches}
              {nearestCA.altKm != null ? `alt ${fmtDist(nearestCA.altKm)}` : fmtDist(nearestCA.distKm)} — {fmtTimeShort(nearestCA.et)}
            {:else}
              {@const minCA = allCloseApproaches.reduce((a, b) => a.distKm < b.distKm ? a : b)}
              {allCloseApproaches.length} approaches — min {minCA.altKm != null ? `alt ${fmtDist(minCA.altKm)}` : fmtDist(minCA.distKm)}
            {/if}
          </span>
          <button class="ctrl-link" onclick={() => { showApproaches = !showApproaches; if (!showApproaches) showApproachTable = false; }}>
            {showApproaches ? 'hide' : 'show'}
          </button>
          {#if showApproaches}
            <button class="ctrl-link" onclick={() => showApproachTable = !showApproachTable}>
              {showApproachTable ? 'collapse' : 'list'}
            </button>
          {/if}
        </div>
      {/if}

      <!-- Close approach table -->
      {#if showApproachTable && allCloseApproaches.length > 0}
        <div class="pt-1.5 border-t border-border">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-[10px] text-text-secondary uppercase tracking-wider font-semibold">Close Approaches</span>
            <div class="flex gap-0.5">
              <button
                class="sort-btn"
                class:active={approachSort === 'distance'}
                onclick={() => approachSort = 'distance'}
              >dist</button>
              <button
                class="sort-btn"
                class:active={approachSort === 'date'}
                onclick={() => approachSort = 'date'}
              >date</button>
            </div>
          </div>
          <div class="max-h-56 overflow-y-auto flex flex-col">
            {#each sortedApproaches as ca, i}
              <button
                class="flex justify-between gap-2 text-[11px] font-mono bg-transparent border-none cursor-pointer text-left px-1.5 py-1 rounded hover:bg-surface-3 transition-colors w-full"
                onclick={() => setTime(ca.et)}
              >
                <span class="text-text-muted opacity-50 w-5">{i + 1}</span>
                <span class="text-success flex-1">{ca.altKm != null ? `alt ${fmtDist(ca.altKm)}` : fmtDist(ca.distKm)}</span>
                <span class="text-text-muted">{fmtTimeShort(ca.et)}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {:else if targetBodyName && fromBodyName}
    <div class="text-text-muted text-[11px] pt-2 border-t border-border">Computing...</div>
  {:else if !fromBodyName}
    <div class="text-text-muted text-[11px] pt-2 border-t border-border">Select a From body or track one in the viewport</div>
  {/if}
</div>

<style>
  @keyframes fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-fade-in { animation: fade-in 0.12s ease; }

  .chart-wrap {
    position: relative;
  }

  .y-range {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-text-muted);
    opacity: 0.85;
  }

  .ctrl-link {
    font-size: 10px;
    color: var(--color-text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: color 0.1s;
  }
  .ctrl-link:hover {
    color: var(--color-text-primary);
  }

  .sort-btn {
    font-size: 10px;
    color: var(--color-text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    transition: color 0.1s, background 0.1s;
  }
  .sort-btn:hover {
    color: var(--color-text-primary);
  }
  .sort-btn.active {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }

  .y-range {
    font-size: 10px;
    color: var(--color-text-muted);
    opacity: 0.9;
    margin-top: 2px;
    text-align: right;
  }

  .chart {
    width: 100%;
    height: 28px;
    display: block;
    border-radius: 4px;
    background: var(--color-surface-3);
  }
  .chart.hoverable {
    cursor: crosshair;
  }
</style>
