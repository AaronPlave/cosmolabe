/**
 * Pre-computed trajectory cache with adaptive sampling and Visvalingam-Whyatt simplification.
 *
 * Samples a trajectory at load time, concentrating point density where curvature
 * is highest (flybys, orbital insertions) and thinning straight cruise phases.
 * At render time, extracting visible points is a binary search + array read —
 * no SPICE calls needed.
 */

/** A time interval [start, end] in ET seconds. */
export interface CoverageWindow {
  start: number;
  end: number;
}

export interface TrajectoryCacheConfig {
  /** Target number of points in the simplified cache. Default 100,000. */
  maxPoints?: number;
  /** Coarse sampling interval in seconds for the initial pass. Default 3600 (1 hour). */
  coarseInterval?: number;
  /** Minimum subdivision interval in seconds during refinement. Default 30. */
  minInterval?: number;
  /** Midpoint deviation ratio threshold triggering subdivision. Default 0.001 (0.1%). */
  deviationThreshold?: number;
  /** Safety cap on raw samples before simplification. Default 500,000. */
  maxRawSamples?: number;
  /** Exact coverage windows from spkcov. When provided, skips the 1-day probe
   *  and samples only within these windows. */
  coverageWindows?: CoverageWindow[];
}

export class TrajectoryCache {
  /** Sorted epoch times (ET seconds). Length = count. */
  readonly times: Float64Array;
  /** Interleaved positions in km: [x0,y0,z0, x1,y1,z1, ...]. Length = count * 3. */
  readonly positions: Float64Array;
  /** Number of points in the cache. */
  readonly count: number;

  private constructor(times: Float64Array, positions: Float64Array, count: number) {
    this.times = times;
    this.positions = positions;
    this.count = count;
  }

  /**
   * Reconstitute a TrajectoryCache from raw typed arrays.
   * Used to receive cache data transferred from a Web Worker.
   */
  static fromArrays(times: Float64Array, positions: Float64Array, count: number): TrajectoryCache {
    return new TrajectoryCache(times, positions, count);
  }

  /**
   * Build a trajectory cache by adaptively sampling and simplifying.
   *
   * 1. Probes the search range at 1-day intervals to find actual kernel coverage.
   * 2. Adaptively samples within coverage: uniform 1-hour grid, then recursive
   *    midpoint subdivision where curvature exceeds the threshold (down to minInterval).
   * 3. Applies Visvalingam-Whyatt simplification to reduce to maxPoints, preserving
   *    high-curvature geometry (flybys) and thinning low-curvature cruise phases.
   *
   * @param resolver Position resolver: returns [x,y,z] in km at epoch t.
   *   Must use the same coordinate system that TrajectoryLine expects.
   *   Returns [NaN,NaN,NaN] for times outside kernel coverage.
   * @param searchStart Start of search range (ET). May extend before actual coverage.
   * @param searchEnd End of search range (ET). May extend past actual coverage.
   * @param config Optional tuning parameters.
   */
  static build(
    resolver: (t: number) => [number, number, number],
    searchStart: number,
    searchEnd: number,
    config?: TrajectoryCacheConfig,
  ): TrajectoryCache {
    const maxPoints = config?.maxPoints ?? 100_000;
    const coarseInterval = config?.coarseInterval ?? 3600;
    const minInterval = config?.minInterval ?? 30;
    const deviationThreshold = config?.deviationThreshold ?? 0.001;
    const maxRaw = config?.maxRawSamples ?? 500_000;
    const coverageWindows = config?.coverageWindows;

    // Phase 0: Determine coverage range(s).
    // If spkcov windows are provided, use them directly (exact, single SPICE call).
    // Otherwise fall back to probing at 1-day intervals.
    let segments: Array<[number, number]>;

    if (coverageWindows && coverageWindows.length > 0) {
      // Use exact coverage from spkcov — authoritative, no clipping needed
      segments = [];
      for (const w of coverageWindows) {
        if (w.end > w.start) segments.push([w.start, w.end]);
      }
    } else {
      // Probe at 1-day intervals to find approximate coverage
      const PROBE_STEP = 86400;
      let coverageStart = -1;
      let coverageEnd = -1;
      for (let t = searchStart; t <= searchEnd; t += PROBE_STEP) {
        const pos = resolver(t);
        if (!isNaN(pos[0])) {
          if (coverageStart < 0) coverageStart = t;
          coverageEnd = t;
        }
      }
      {
        const pos = resolver(searchEnd);
        if (!isNaN(pos[0])) {
          if (coverageStart < 0) coverageStart = searchEnd;
          coverageEnd = searchEnd;
        }
      }
      if (coverageStart >= 0) {
        // Extend slightly beyond probe boundaries to capture edge data
        segments = [[
          Math.max(searchStart, coverageStart - PROBE_STEP),
          Math.min(searchEnd, coverageEnd + PROBE_STEP),
        ]];
      } else {
        segments = [];
      }
    }

    if (segments.length === 0) {
      return new TrajectoryCache(new Float64Array(0), new Float64Array(0), 0);
    }

    // Phase 1: Adaptive sampling within each coverage segment.
    // Multiple segments handle disjoint coverage (e.g., SPK gaps).
    const perSegBudget = Math.ceil(maxRaw / segments.length);
    const allRaw: SampleBuffer[] = [];
    let totalRawCount = 0;

    for (const [segStart, segEnd] of segments) {
      const raw = adaptiveSample(
        resolver, segStart, segEnd,
        coarseInterval, minInterval, deviationThreshold,
        Math.min(perSegBudget, maxRaw - totalRawCount),
      );
      if (raw.count > 0) {
        allRaw.push(raw);
        totalRawCount += raw.count;
      }
    }

    if (totalRawCount === 0) {
      return new TrajectoryCache(new Float64Array(0), new Float64Array(0), 0);
    }

    // Merge all segments into a single sorted buffer
    let mergedTimes: Float64Array;
    let mergedPositions: Float64Array;
    if (allRaw.length === 1) {
      mergedTimes = allRaw[0].times.slice(0, allRaw[0].count);
      mergedPositions = allRaw[0].positions.slice(0, allRaw[0].count * 3);
    } else {
      mergedTimes = new Float64Array(totalRawCount);
      mergedPositions = new Float64Array(totalRawCount * 3);
      let offset = 0;
      for (const raw of allRaw) {
        mergedTimes.set(raw.times.subarray(0, raw.count), offset);
        mergedPositions.set(raw.positions.subarray(0, raw.count * 3), offset * 3);
        offset += raw.count;
      }
    }

    // Phase 2: Visvalingam-Whyatt simplification if over budget
    if (totalRawCount <= maxPoints) {
      return new TrajectoryCache(mergedTimes, mergedPositions, totalRawCount);
    }

    const result = visvalingamSimplify(mergedTimes, mergedPositions, totalRawCount, maxPoints);
    return new TrajectoryCache(result.times, result.positions, result.count);
  }

  /**
   * Find indices [lo, hi) of points within the time window [tStart, tEnd].
   * Points at indices lo..hi-1 have times in [tStart, tEnd].
   * O(log n) via binary search.
   */
  getWindowIndices(tStart: number, tEnd: number): [number, number] {
    return [
      lowerBound(this.times, tStart, 0, this.count),
      upperBound(this.times, tEnd, 0, this.count),
    ];
  }
}


// ─── Adaptive Sampling ────────────────────────────────────────────────

interface SampleBuffer {
  times: Float64Array;
  positions: Float64Array; // interleaved [x0,y0,z0, x1,y1,z1, ...]
  count: number;
}

function adaptiveSample(
  resolver: (t: number) => [number, number, number],
  startTime: number,
  endTime: number,
  coarseInterval: number,
  minInterval: number,
  deviationThreshold: number,
  maxSamples: number,
): SampleBuffer {
  const duration = endTime - startTime;
  if (duration <= 0) {
    return { times: new Float64Array(0), positions: new Float64Array(0), count: 0 };
  }

  // Pre-allocate output buffers
  let capacity = Math.min(maxSamples, Math.ceil(duration / coarseInterval) * 8);
  let times = new Float64Array(capacity);
  let positions = new Float64Array(capacity * 3);
  let count = 0;

  function push(t: number, x: number, y: number, z: number): void {
    if (count >= capacity) {
      capacity = Math.min(maxSamples, capacity * 2);
      const newTimes = new Float64Array(capacity);
      const newPositions = new Float64Array(capacity * 3);
      newTimes.set(times.subarray(0, count));
      newPositions.set(positions.subarray(0, count * 3));
      times = newTimes;
      positions = newPositions;
    }
    times[count] = t;
    const base = count * 3;
    positions[base] = x;
    positions[base + 1] = y;
    positions[base + 2] = z;
    count++;
  }

  // Phase 1: Coarse uniform grid
  const numCoarse = Math.ceil(duration / coarseInterval) + 1;
  const coarseT: number[] = [];
  const coarseX: number[] = [];
  const coarseY: number[] = [];
  const coarseZ: number[] = [];

  for (let i = 0; i < numCoarse; i++) {
    const t = Math.min(startTime + i * coarseInterval, endTime);
    const pos = resolver(t);
    if (!isNaN(pos[0])) {
      coarseT.push(t);
      coarseX.push(pos[0]);
      coarseY.push(pos[1]);
      coarseZ.push(pos[2]);
    }
  }
  // Ensure exact end time is included
  if (coarseT.length > 0 && coarseT[coarseT.length - 1] < endTime) {
    const pos = resolver(endTime);
    if (!isNaN(pos[0])) {
      coarseT.push(endTime);
      coarseX.push(pos[0]);
      coarseY.push(pos[1]);
      coarseZ.push(pos[2]);
    }
  }

  if (coarseT.length < 2) {
    for (let i = 0; i < coarseT.length; i++) {
      push(coarseT[i], coarseX[i], coarseY[i], coarseZ[i]);
    }
    return { times, positions, count };
  }

  // Phase 2: Recursive midpoint refinement where curvature is high.
  // Each refine() call is responsible for pushing its LEFT endpoint only.
  // The right endpoint is the left of the next call (or the final push).
  const maxDepth = Math.ceil(Math.log2(Math.max(coarseInterval / minInterval, 2))) + 2;

  function refine(
    t0: number, x0: number, y0: number, z0: number,
    t1: number, x1: number, y1: number, z1: number,
    depth: number,
  ): void {
    const dt = t1 - t0;
    if (count >= maxSamples || dt <= minInterval || depth >= maxDepth) {
      push(t0, x0, y0, z0);
      return;
    }

    const midT = (t0 + t1) * 0.5;
    const midPos = resolver(midT);
    if (isNaN(midPos[0])) {
      // Kernel gap at midpoint — don't subdivide, just emit left endpoint
      push(t0, x0, y0, z0);
      return;
    }

    // Midpoint deviation test: how far does the actual midpoint deviate
    // from the linear interpolation between endpoints?
    const linX = (x0 + x1) * 0.5;
    const linY = (y0 + y1) * 0.5;
    const linZ = (z0 + z1) * 0.5;
    const devX = midPos[0] - linX, devY = midPos[1] - linY, devZ = midPos[2] - linZ;
    const deviation = Math.sqrt(devX * devX + devY * devY + devZ * devZ);

    const chordX = x1 - x0, chordY = y1 - y0, chordZ = z1 - z0;
    const chordLen = Math.sqrt(chordX * chordX + chordY * chordY + chordZ * chordZ);

    if (chordLen > 0 && deviation / chordLen > deviationThreshold) {
      // Significant curvature — subdivide both halves
      refine(t0, x0, y0, z0, midT, midPos[0], midPos[1], midPos[2], depth + 1);
      if (count >= maxSamples) return;
      refine(midT, midPos[0], midPos[1], midPos[2], t1, x1, y1, z1, depth + 1);
      return;
    }

    // Straight enough — just push the left endpoint
    push(t0, x0, y0, z0);
  }

  for (let i = 0; i < coarseT.length - 1; i++) {
    if (count >= maxSamples) break;
    refine(
      coarseT[i], coarseX[i], coarseY[i], coarseZ[i],
      coarseT[i + 1], coarseX[i + 1], coarseY[i + 1], coarseZ[i + 1],
      0,
    );
  }
  // Push the very last point
  if (count < maxSamples && coarseT.length > 0) {
    const last = coarseT.length - 1;
    push(coarseT[last], coarseX[last], coarseY[last], coarseZ[last]);
  }

  return { times, positions, count };
}


// ─── Visvalingam-Whyatt Simplification ────────────────────────────────
//
// Iteratively removes the point with the smallest "effective area" (the
// triangle formed with its two neighbors). Points near high-curvature
// regions form large triangles and are preserved; points on straight
// cruise-phase segments form tiny triangles and are culled first.
//
// Uses a binary min-heap with lazy deletion for O(n log n) performance.

function visvalingamSimplify(
  times: Float64Array,
  positions: Float64Array,
  n: number,
  targetCount: number,
): SampleBuffer {
  if (n <= targetCount) {
    return {
      times: times.slice(0, n),
      positions: positions.slice(0, n * 3),
      count: n,
    };
  }

  // Doubly linked list for O(1) neighbor traversal after removal
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  next[n - 1] = -1; // End sentinel

  // Effective area per point
  const area = new Float64Array(n);
  area[0] = Infinity;       // Never remove first
  area[n - 1] = Infinity;   // Never remove last

  function triArea(i: number): number {
    const pi = prev[i], ni = next[i];
    if (pi < 0 || ni < 0) return Infinity;
    const p3 = pi * 3, i3 = i * 3, n3 = ni * 3;
    // Cross product of (positions[i] - positions[prev]) × (positions[next] - positions[prev])
    const dx1 = positions[i3] - positions[p3];
    const dy1 = positions[i3 + 1] - positions[p3 + 1];
    const dz1 = positions[i3 + 2] - positions[p3 + 2];
    const dx2 = positions[n3] - positions[p3];
    const dy2 = positions[n3 + 1] - positions[p3 + 1];
    const dz2 = positions[n3 + 2] - positions[p3 + 2];
    const cx = dy1 * dz2 - dz1 * dy2;
    const cy = dz1 * dx2 - dx1 * dz2;
    const cz = dx1 * dy2 - dy1 * dx2;
    return Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
  }

  for (let i = 1; i < n - 1; i++) {
    area[i] = triArea(i);
  }

  // Min-heap with lazy deletion.
  // Each entry is [effectiveArea, pointIndex]. Stale entries (removed point
  // or area updated since push) are detected and skipped on pop.
  const heap: Array<[number, number]> = [];
  let heapLen = 0;

  function hPush(a: number, idx: number): void {
    if (heapLen < heap.length) {
      heap[heapLen] = [a, idx];
    } else {
      heap.push([a, idx]);
    }
    // Sift up
    let i = heapLen;
    heapLen++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
      i = p;
    }
  }

  function hPop(): [number, number] | undefined {
    if (heapLen === 0) return undefined;
    const top = heap[0];
    heapLen--;
    if (heapLen > 0) {
      heap[0] = heap[heapLen];
      let i = 0;
      while (true) {
        let s = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < heapLen && heap[l][0] < heap[s][0]) s = l;
        if (r < heapLen && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        const tmp = heap[i]; heap[i] = heap[s]; heap[s] = tmp;
        i = s;
      }
    }
    return top;
  }

  // Build initial heap (all interior points)
  const removed = new Uint8Array(n);
  for (let i = 1; i < n - 1; i++) {
    hPush(area[i], i);
  }

  // Remove points until we reach targetCount
  let remaining = n;
  while (remaining > targetCount) {
    const entry = hPop();
    if (!entry) break;
    const [a, idx] = entry;

    // Skip stale entries (already removed, or area was updated since this push)
    if (removed[idx] || a !== area[idx]) continue;

    // Remove this point
    removed[idx] = 1;
    remaining--;

    // Update linked list
    const pi = prev[idx], ni = next[idx];
    if (ni >= 0) prev[ni] = pi;
    if (pi >= 0) next[pi] = ni;

    // Recompute neighbor areas with monotonicity enforcement:
    // A point's effective area never decreases, preventing visual artifacts.
    if (pi > 0 && !removed[pi]) {
      const newA = triArea(pi);
      area[pi] = Math.max(area[pi], newA);
      hPush(area[pi], pi);
    }
    if (ni >= 0 && ni < n - 1 && !removed[ni]) {
      const newA = triArea(ni);
      area[ni] = Math.max(area[ni], newA);
      hPush(area[ni], ni);
    }
  }

  // Collect surviving points by following the linked list from index 0
  const outTimes = new Float64Array(remaining);
  const outPositions = new Float64Array(remaining * 3);
  let cur = 0;
  let out = 0;
  while (cur >= 0) {
    outTimes[out] = times[cur];
    const c3 = cur * 3, o3 = out * 3;
    outPositions[o3] = positions[c3];
    outPositions[o3 + 1] = positions[c3 + 1];
    outPositions[o3 + 2] = positions[c3 + 2];
    out++;
    cur = next[cur];
  }

  return { times: outTimes, positions: outPositions, count: out };
}


// ─── Binary Search Helpers ────────────────────────────────────────────

/** First index where times[i] >= target */
function lowerBound(times: Float64Array, target: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index where times[i] > target */
function upperBound(times: Float64Array, target: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
