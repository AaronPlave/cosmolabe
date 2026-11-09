/**
 * ISS Live channel mapping (#371). Provenance: item IDs and names come from
 * the community ISS-Mimic project's telemetry table
 * (github.com/ISS-Mimic/Mimic, Pi/database_initialize.py), and were each
 * observed delivering values from push.lightstreamer.com (adapter ISSLIVE) on
 * 2026-11-09. They are NOT NASA-authored field definitions: ordering,
 * direction, units and zero references that the provider does not state are
 * marked below and stay `unverified`.
 */
import type { JointChannels, LiveIssConfig } from './source.js';
import type { LightstreamerConfig } from './transport.js';

export const ISS_LIVE_SERVER = 'https://push.lightstreamer.com';
export const ISS_LIVE_ADAPTER = 'ISSLIVE';
/** Fields delivered per item; `Status.Class` 24 is the provider's "good" class (used by ISS-Mimic as the live test). */
export const ISS_LIVE_FIELDS = ['TimeStamp', 'Value', 'Status.Class'] as const;

/**
 * `USGNC_PS_Pointing_LVLH_Att_Quatrn_0..3`. The item name states LVLH, and
 * USLAB000017 (`USGNC_CA_Act_CCDB_Att_Cntl_Ref_Frame`) reads "LVLH" when
 * observed. Component order (item _0 = scalar) and rotation direction are
 * NOT stated by the provider: _0 ~ 1.0 in observed samples, so scalar-first
 * is the only plausible order, but the direction is unconfirmed.
 */
export const ISS_ATTITUDE_ITEMS = ['USLAB000018', 'USLAB000019', 'USLAB000020', 'USLAB000021'] as const;

/**
 * Joint items, units degrees (values 0-360 observed). Port/starboard SARJ are
 * S0000004 / S0000003 (ISS-Mimic labels `psarj`/`ssarj`); the observed values
 * were mirrored (69.06 / 290.98), so the model rotation sign differs per
 * side. Wings: which of a truss's two wings is `_01` in the model is NOT
 * established, so the BGA map below is a CANDIDATE and `offsetsRad`/signs
 * need an independent check before the joints are trusted.
 */
export const CANDIDATE_JOINT_ITEMS: Readonly<Record<string, string>> = {
  'truss:P4': 'S0000004',
  'truss:S4': 'S0000003',
  // Mimic: beta1a S4000007, 3a S4000008 (S4); 1b S6000008, 3b S6000007 (S6); 2a P4000007, 4a P4000008 (P4); 2b P6000008, 4b P6000007 (P6)
  'array:S4_01': 'S4000007', 'array:S4_02': 'S4000008',
  'array:S6_01': 'S6000008', 'array:S6_02': 'S6000007',
  'array:P4_01': 'P4000007', 'array:P4_02': 'P4000008',
  'array:P6_01': 'P6000008', 'array:P6_02': 'P6000007',
};

/**
 * ISS Live `TimeStamp`: fractional hours since 00:00 UTC on 31 December of the
 * previous year (so 1 January 00:00 is 24.0). This is the convention
 * ISS-Mimic's own freshness test uses (Pi/iss_telemetry.py). `year` selects the
 * year the stamp belongs to; the feed is live so use the current UTC year.
 */
export function parseIssLiveTimestamp(raw: string, year: number): number {
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? Date.UTC(year - 1, 11, 31) + hours * 3_600_000 : NaN;
}

export function issLiveTransportConfig(now: () => number = Date.now, items: readonly string[] = [...ISS_ATTITUDE_ITEMS]): LightstreamerConfig {
  return {
    server: ISS_LIVE_SERVER,
    adapterSet: ISS_LIVE_ADAPTER,
    items,
    fields: ISS_LIVE_FIELDS,
    valueField: 'Value',
    timeField: 'TimeStamp',
    statusField: 'Status.Class',
    goodStatus: '24',
    parseSourceTime: (raw) => parseIssLiveTimestamp(raw, new Date(now()).getUTCFullYear()),
  };
}

export function issLiveConfig(options: { joints?: JointChannels } = {}): LiveIssConfig {
  return {
    attitude: {
      items: ISS_ATTITUDE_ITEMS,
      order: 'scalar-first',
      convention: { reference: 'LVLH', direction: 'reference-to-body' },
      verification: 'unverified',
      // Quaternion items update independently within about a second.
      toleranceMs: 1500,
    },
    joints: options.joints,
  };
}
