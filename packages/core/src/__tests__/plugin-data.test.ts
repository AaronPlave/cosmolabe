import { describe, expect, it } from 'vitest';
import { HostDataAdapter, exploratoryData, type HostData, type PluginData, type DataProvenance } from '../plugins/PluginData.js';

const provenance: DataProvenance = {
  id: 'contacts', kind: 'analysis', classification: 'planned',
  validity: { startEt: 0, endEt: 100 },
  parents: [{ id: 'mission', kind: 'entity', parents: [{ id: 'package', kind: 'package', license: 'CC-BY-4.0', citation: 'Mission team' }] }],
};

describe('plugin data authority', () => {
  it('requires adapter issuance for host data and preserves the provenance chain', () => {
    // @ts-expect-error Host values require the adapter's inaccessible brand.
    const forged: HostData<number> = { authority: 'host', value: 1, provenance, adapterId: 'fake' };
    void forged;
    const local = exploratoryData(1, provenance);
    // @ts-expect-error Computation cannot be promoted by editing authority.
    const promoted: PluginData<number> = { ...local, authority: 'host' };
    void promoted;
    const host: PluginData<number> = new HostDataAdapter('astrolabe').supply(1, provenance);
    expect(host.authority).toBe('host');
    expect(host.provenance.parents?.[0].parents?.[0].license).toBe('CC-BY-4.0');
    expect(Object.isFrozen(host)).toBe(true);
    expect(local.authority).toBe('exploratory');
  });
  it('requires an identifiable adapter', () => {
    expect(() => new HostDataAdapter(' ')).toThrow();
  });
});
