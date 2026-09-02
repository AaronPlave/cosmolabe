// @cosmolabe/frames: the seam of the merged system (ADR M-0002). The contracts
// module is the published surface everything above the tier types against; the
// frames module is the cspice-wasm backed implementation. See CLAUDE.md iron
// rules 1 (nothing above this tier calls CSPICE) and 9 (SPICE kilometers at
// the contracts).

export type {
  BodyId,
  Correction,
  Et,
  FrameChain,
  FrameChainLeg,
  FrameChainNode,
  FrameId,
  FramesService,
  IsoString,
  KernelInfo,
  KernelSetInfo,
  QuatBatch,
  Seconds,
  StateBatch,
  StateProvider,
  StateQuery,
} from './contracts.ts';
export {
  createFramesLayer,
  framesLayerOver,
  describeChain,
  type FramesLayer,
  type FramesLayerOptions,
} from './frames.ts';
export {
  createHeritageSpice,
  type HeritageSpice,
  type HeritageSpiceOptions,
} from './heritage-spice.ts';
export { sha256Hex, sha256HexOfText } from './sha256.ts';
