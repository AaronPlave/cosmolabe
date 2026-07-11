// The frames tier implementation over cspice-wasm: one in-process layer that
// implements both M-0002 contracts. It owns kernel lifecycle (furnish, unload,
// the hashable set), epoch conversion, frame chains, and batched state and
// orientation queries. It is deliberately cache-free: caching and interpolation
// live in the cores above, and the differential harness measures them there
// (pipeline mode); this layer is the call-parity truth path.

import {
  createSpiceBindings,
  type SpiceBindings,
  type SpiceEngineOptions,
} from 'cspice-wasm';
import type {
  BodyId,
  Correction,
  Et,
  FrameChain,
  FrameChainLeg,
  FrameChainNode,
  FrameId,
  IsoString,
  FramesService,
  KernelInfo,
  KernelSetInfo,
  QuatBatch,
  StateBatch,
  StateProvider,
  StateQuery,
} from './contracts.ts';
import { sha256Hex, sha256HexOfText } from './sha256.ts';

const CORRECTIONS: readonly Correction[] = ['NONE', 'LT', 'LT+S', 'CN', 'CN+S'];

/**
 * The frames layer: both M-0002 contracts plus the kernel lifecycle the
 * FramesService hash reports over. Kernel bytes arrive from the host layer
 * (fetch, OPFS, filesystem); this tier never reads storage itself.
 */
export interface FramesLayer extends StateProvider, FramesService {
  /** Furnish a kernel from bytes under a logical name; recorded in kernels(). */
  furnish(name: string, bytes: Uint8Array): void;
  /** Unload a previously furnished kernel and drop it from kernels(). */
  unload(name: string): void;
}

export type FramesLayerOptions = SpiceEngineOptions;

/** Iron rule of the contract: correction is explicit at every call site, never defaulted. */
function requireCorrection(correction: unknown): Correction {
  if (typeof correction === 'string' && (CORRECTIONS as readonly string[]).includes(correction)) {
    return correction as Correction;
  }
  throw new Error(
    `StateQuery.correction is required and must be one of ${CORRECTIONS.join(', ')}; ` +
      `got ${String(correction)}. The seam never defaults aberration correction (ADR M-0002).`,
  );
}

/** Expand the contract's epoch union into a concrete sample array. */
function expandEpochs(epochs: StateQuery['epochs']): Float64Array {
  if (Array.isArray(epochs)) {
    if (epochs.length === 0) throw new Error('StateQuery.epochs must contain at least one epoch.');
    return Float64Array.from(epochs);
  }
  const { start, end, step } = epochs;
  if (!(step > 0)) throw new Error(`StateQuery.epochs.step must be positive; got ${step}.`);
  if (!(end >= start)) throw new Error(`StateQuery.epochs range is empty: end ${end} < start ${start}.`);
  // Inclusive of start; end is included exactly when (end - start) is an
  // integer multiple of step (the last sample never overshoots end).
  const n = Math.floor((end - start) / step) + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = start + i * step;
  return out;
}

function chainNode(bindings: SpiceBindings, frame: FrameId): FrameChainNode {
  const frameId = bindings.namfrm(frame);
  if (frameId === 0) {
    throw new Error(`Frame '${frame}' is not known to the furnished kernel set (namfrm returned 0).`);
  }
  return { frame, frameId };
}

/** Render a FrameChain as one loggable line, for harness reports and debugging. */
export function describeChain(chain: FrameChain): string {
  const path = chain.nodes.map((n) => `${n.frame}(${n.frameId})`).join(' -> ');
  return `${path} at et ${chain.epoch}`;
}

/** Create the frames layer: loads the CSPICE WASM module and binds both contracts to it. */
export async function createFramesLayer(options?: FramesLayerOptions): Promise<FramesLayer> {
  const bindings = await createSpiceBindings(options);
  const furnished: KernelInfo[] = [];

  /** Resolve a body to its body-fixed frame: an explicit frame name passes
   * through (the CK case, for example CASSINI_SC_COORD); otherwise the IAU
   * body frame must exist in the furnished kernel set. */
  const bodyFixedFrame = (body: BodyId): FrameId => {
    if (bindings.namfrm(body) !== 0) return body;
    const iau = `IAU_${body.toUpperCase()}`;
    if (bindings.namfrm(iau) !== 0) return iau;
    throw new Error(
      `No body-fixed frame for '${body}': neither a frame of that name nor ${iau} ` +
        `is known to the furnished kernel set.`,
    );
  };

  return {
    furnish(name, bytes) {
      bindings.furnsh(name, bytes);
      furnished.push({ name, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
    },

    unload(name) {
      bindings.unload(name);
      const at = furnished.findIndex((k) => k.name === name);
      if (at >= 0) furnished.splice(at, 1);
    },

    async states(q: StateQuery): Promise<StateBatch> {
      const correction = requireCorrection(q.correction);
      if (q.targets.length === 0) throw new Error('StateQuery.targets must name at least one body.');
      const epochs = expandEpochs(q.epochs);
      const n = epochs.length;

      if (q.targets.length === 1) {
        // Single target: hand the batch arrays through unchanged (zero-copy).
        const batch = bindings.spkezrBatch(q.targets[0]!, epochs, q.frame, correction, q.observer);
        return {
          targets: [...q.targets],
          observer: q.observer,
          frame: q.frame,
          correction,
          epochs,
          states: batch.states,
          lightTimes: batch.lightTimes,
        };
      }

      const states = new Float64Array(q.targets.length * n * 6);
      const lightTimes = new Float64Array(q.targets.length * n);
      for (let t = 0; t < q.targets.length; t++) {
        const batch = bindings.spkezrBatch(q.targets[t]!, epochs, q.frame, correction, q.observer);
        states.set(batch.states, t * n * 6);
        lightTimes.set(batch.lightTimes, t * n);
      }
      return {
        targets: [...q.targets],
        observer: q.observer,
        frame: q.frame,
        correction,
        epochs,
        states,
        lightTimes,
      };
    },

    async orientation(body: BodyId, frame: FrameId, epochs: Et[]): Promise<QuatBatch> {
      if (epochs.length === 0) throw new Error('orientation() needs at least one epoch.');
      const bodyFrame = bodyFixedFrame(body);
      const ets = Float64Array.from(epochs);
      const quats = new Float64Array(ets.length * 4);
      for (let i = 0; i < ets.length; i++) {
        const q = bindings.m2q(bindings.pxform(frame, bodyFrame, ets[i]!));
        quats[i * 4] = q[0]!;
        quats[i * 4 + 1] = q[1]!;
        quats[i * 4 + 2] = q[2]!;
        quats[i * 4 + 3] = q[3]!;
      }
      return { body, frame, bodyFrame, epochs: ets, quats };
    },

    toEt(utc: IsoString): Et {
      // ISO instants are UTC by definition; str2et rejects a trailing Z, so the
      // one conversion authority strips it rather than every caller learning to.
      return bindings.str2et(utc.endsWith('Z') ? utc.slice(0, -1) : utc);
    },

    chain(from: FrameId, to: FrameId, epoch: Et): FrameChain {
      const fromNode = chainNode(bindings, from);
      const toNode = chainNode(bindings, to);
      const rotation = bindings.pxform(from, to, epoch);

      let nodes: readonly FrameChainNode[];
      let legs: readonly FrameChainLeg[];
      if (from === to) {
        nodes = [fromNode];
        legs = [];
      } else if (from === 'J2000' || to === 'J2000') {
        nodes = [fromNode, toNode];
        legs = [{ from, to, rotation }];
      } else {
        const pivot = chainNode(bindings, 'J2000');
        nodes = [fromNode, pivot, toNode];
        legs = [
          { from, to: 'J2000', rotation: bindings.pxform(from, 'J2000', epoch) },
          { from: 'J2000', to, rotation: bindings.pxform('J2000', to, epoch) },
        ];
      }
      return { from, to, epoch, nodes, legs, rotation };
    },

    kernels(): KernelSetInfo {
      const kernels = [...furnished];
      const setHash = sha256HexOfText(
        kernels
          .map((k) => k.sha256)
          .sort()
          .join('\n'),
      );
      return { count: kernels.length, kernels, setHash };
    },
  };
}
