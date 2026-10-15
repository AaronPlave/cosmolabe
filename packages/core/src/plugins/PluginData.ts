/** A provenance node. Parents preserve package → entity → product ancestry. */
export interface DataProvenance {
  readonly id: string;
  readonly kind: 'catalog-source' | 'package' | 'entity' | 'trajectory' | 'attitude' | 'surface' | 'observation' | 'analysis' | 'dataset' | 'kernel';
  readonly source?: string;
  readonly version?: string;
  readonly citation?: string;
  readonly license?: string;
  readonly validity?: { readonly startEt: number; readonly endEt: number };
  readonly classification?: 'authoritative' | 'reconstructed' | 'planned' | 'exploratory' | 'synthetic';
  readonly parents?: readonly DataProvenance[];
}

// Not exported: structural object literals cannot mint host authority.
const hostAuthority: unique symbol = Symbol('adapter-issued-host-data');
export interface HostData<T> {
  readonly authority: 'host';
  readonly value: T;
  readonly provenance: DataProvenance;
  readonly adapterId: string;
  readonly [hostAuthority]: true;
}
export interface ExploratoryData<T> {
  readonly authority: 'exploratory';
  readonly value: T;
  readonly provenance: DataProvenance;
}
export type PluginData<T> = HostData<T> | ExploratoryData<T>;

/** The host integration's explicit trust boundary, not a plugin capability.
 * Hosts own adapters and pass their outputs to plugins. Authority describes
 * where a value was supplied, independently of planned/reconstructed status.
 * This is a TypeScript API boundary, not a sandbox against casts or hostile JS.
 */
export class HostDataAdapter {
  constructor(readonly id: string) {
    if (!id.trim()) throw new Error('Host adapter ID is required');
  }
  supply<T>(value: T, provenance: DataProvenance): HostData<T> {
    return Object.freeze({ authority: 'host', adapterId: this.id, value, provenance, [hostAuthority]: true as const });
  }
}
export function exploratoryData<T>(value: T, provenance: DataProvenance): ExploratoryData<T> {
  return Object.freeze({ authority: 'exploratory', value, provenance });
}

/** Host contact windows use inclusive ET seconds and body names. */
export interface ContactWindow {
  readonly spacecraft: string;
  readonly station: string;
  readonly startEt: number;
  readonly endEt: number;
  readonly provenance?: DataProvenance;
}

/** Semantic plugin palette: accent means computed here; red means fault. */
export const PLUGIN_DATA_COLORS = Object.freeze({ exploratory: 0x6eaaff, host: 0xaaadb4, fault: 0xf87171 });
