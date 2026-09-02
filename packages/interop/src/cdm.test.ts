import { describe, it, expect } from 'vitest';
import { parseCdm, CdmError } from './cdm.ts';

// A trimmed CCSDS CDM (KVN) with the relative-state summary and two objects.
const CDM = `CCSDS_CDM_VERS = 1.0
CREATION_DATE = 2010-03-12T22:31:12.000
ORIGINATOR = JSPOC
MESSAGE_ID = 201003121200_conj_38096_37820

TCA = 2010-03-13T22:37:52.618
MISS_DISTANCE = 715 [m]
RELATIVE_SPEED = 14762 [m/s]

OBJECT = OBJECT1
OBJECT_DESIGNATOR = 38096
OBJECT_NAME = SATELLITE A

OBJECT = OBJECT2
OBJECT_DESIGNATOR = 37820
OBJECT_NAME = SATELLITE B
`;

describe('parseCdm', () => {
  it('extracts the relative-state summary and both objects', () => {
    const cdm = parseCdm(CDM);
    expect(cdm.tca).toBe('2010-03-13T22:37:52.618');
    expect(cdm.missDistanceM).toBe(715);
    expect(cdm.relativeSpeedMS).toBe(14762);
    expect(cdm.object1.designator).toBe('38096');
    expect(cdm.object1.name).toBe('SATELLITE A');
    expect(cdm.object2.designator).toBe('37820');
  });

  it('rejects a non-CDM document and a CDM missing required fields', () => {
    expect(() => parseCdm('FOO = 1')).toThrow(CdmError);
    expect(() => parseCdm('CCSDS_CDM_VERS = 1.0\nTCA = 2010-01-01T00:00:00')).toThrow(/MISS_DISTANCE/);
  });
});
