import type { Body } from '../Body.js';

/** Core events emitted by Universe. */
export interface UniverseEventMap {
  'geographic:changed': Record<string, never>;
  'time:change': { et: number };
  'body:added': { body: Body };
  'body:removed': { bodyName: string };
  'body:trajectoryChanged': { body: Body };
  'body:rotationChanged': { body: Body };
  'catalog:loaded': { name?: string };
}
