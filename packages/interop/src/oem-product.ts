// The OEM ingest adapter, the second host data adapter under ADR M-0011
// (the first is the MMGIS-shaped one in @bessel/panel): a parsed OEM file
// becomes an AnalysisProduct carrying authority 'host'. The charter holds
// here exactly as there: fidelity, not computation. Every provenance field
// carries the file's own identity in the file's own terms (the header
// ORIGINATOR as the engine, the file name as a file: prefixed kernel-set
// identity so it can never be mistaken for one of our kernel hashes, the
// header CREATION_DATE as computedAt, the OBJECT_ID as the job id), and
// the only transformations are re-layout: geometry re-packs the tabulated
// positions (already kilometers, rule 9) into the polyline layout, and
// series re-columns them per axis. Epoch-to-ET conversion is the caller's
// (the frames tier's toEt or an anchor mapping); this adapter asserts no
// time model and no light-time model (correction 'NONE' stated literally)
// on the file's behalf. The dependency on @bessel/compute is type-only:
// nothing from the compute plane runs here.

import type { AnalysisProduct } from '@bessel/compute';
import type { Oem } from './oem.ts';

export interface OemProductOptions {
  /** The file identity carried into provenance (kernel-set identity file:<name>). */
  readonly fileName: string;
  /** Which canonical form the states re-lay into. */
  readonly kind: 'geometry' | 'series';
  /**
   * Epoch string to ET seconds, required for 'series' (the time axis of the
   * product contract is ET); the adapter refuses to invent one.
   */
  toEt?(epoch: string): number;
}

export function oemToProduct(oem: Oem, opts: OemProductOptions): AnalysisProduct {
  const label = oem.metadata.objectName ?? opts.fileName;
  const frame = oem.metadata.refFrame ?? 'UNKNOWN';

  let product: AnalysisProduct['product'];
  if (opts.kind === 'geometry') {
    const positions = new Float64Array(oem.states.length * 3);
    for (let i = 0; i < oem.states.length; i++) {
      const [x, y, z] = oem.states[i]!.position;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }
    product = { kind: 'geometry', layers: [{ label, frame, form: 'polyline', positions }] };
  } else {
    const toEt = opts.toEt;
    if (!toEt) {
      throw new Error(
        "oemToProduct: the 'series' form needs toEt (the product time axis is ET seconds " +
          'and this adapter asserts no time model of its own; hand in the frames tier ' +
          'conversion or a documented anchor mapping)',
      );
    }
    const et = Float64Array.from(oem.states.map((s) => toEt(s.epoch)));
    product = {
      kind: 'series',
      series: (['x', 'y', 'z'] as const).map((name, c) => ({
        name,
        unit: 'km',
        et,
        values: Float64Array.from(oem.states.map((s) => s.position[c]!)),
      })),
    };
  }

  return {
    product,
    provenance: {
      engine: `oem:${oem.originator ?? 'UNKNOWN'}`,
      version: oem.version,
      kernels: { setHash: `file:${opts.fileName}`, names: [opts.fileName] },
      frame,
      correction: 'NONE',
      authority: 'host',
      computedAt: oem.creationDate ?? oem.metadata.startTime ?? oem.states[0]!.epoch,
      jobId: oem.metadata.objectId ?? opts.fileName,
    },
    units: { [label]: 'km' },
  };
}
