import type { ConfiguredContinuousProfile, ContinuousProfileConfiguration } from '@cosmolabe/core';
import { ViewStateError } from '@cosmolabe/control';
import { PROFILE_QUANTITIES } from './profile-sampling';

/** A shared timeline profile: its definition and flags, never samples. Row
 * order is array order. */
export interface SharedProfile {
  profile: ContinuousProfileConfiguration;
  label: string;
  enabled: boolean;
  visible: boolean;
}
export interface ProfileLinkState {
  version: 1;
  profiles: SharedProfile[];
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ViewStateError(`Profile context: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'malformed definition.');
  return value as Record<string, unknown>;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const et = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 7.5e9;
const ABCORR = ['NONE', 'LT', 'LT+S', 'CN', 'CN+S', 'XLT', 'XLT+S', 'XCN', 'XCN+S'];
const ROLES = ['observer', 'target', 'illuminator'] as const;

/** Allowlist validation: unknown keys are dropped, so a link can carry nothing
 * the profile model doesn't define. Sampling is bounded by the display, not by
 * the link, so there is no work budget here. */
export function validateProfileLinkState(value: unknown): ProfileLinkState {
  const s = object(value);
  check(s.version === 1, 'unsupported version.');
  check(Array.isArray(s.profiles) && s.profiles.length <= 16, 'share at most 16 profiles.');
  const profiles = s.profiles.map((raw): SharedProfile => {
    const entry = object(raw), p = object(entry.profile);
    check(text(entry.label), 'invalid profile label.');
    check(typeof entry.enabled === 'boolean' && typeof entry.visible === 'boolean', 'invalid profile flags.');
    check(typeof p.quantity === 'string' && PROFILE_QUANTITIES.some((q) => q.id === p.quantity), `quantity "${String(p.quantity)}" is unavailable.`);
    const profile: ContinuousProfileConfiguration = { quantity: p.quantity as string };
    if (p.bodies !== undefined) {
      const raw = object(p.bodies), bodies: NonNullable<ContinuousProfileConfiguration['bodies']> = {};
      for (const role of ROLES) {
        if (raw[role] === undefined) continue;
        check(text(raw[role]), `invalid ${role} body.`);
        bodies[role] = raw[role];
      }
      profile.bodies = bodies;
    }
    if (p.window !== undefined) {
      const w = object(p.window);
      check(et(w.start) && et(w.end) && w.end > w.start, 'invalid profile window.');
      profile.window = { start: w.start, end: w.end };
    }
    if (p.frame !== undefined) { check(text(p.frame), 'invalid frame.'); profile.frame = p.frame; }
    if (p.abcorr !== undefined) { check(typeof p.abcorr === 'string' && ABCORR.includes(p.abcorr), 'invalid aberration correction.'); profile.abcorr = p.abcorr; }
    if (p.step !== undefined) { check(typeof p.step === 'number' && Number.isFinite(p.step) && p.step > 0, 'invalid step.'); profile.step = p.step; }
    return { profile, label: entry.label, enabled: entry.enabled, visible: entry.visible };
  });
  return { version: 1, profiles };
}

export const sharedProfileOf = (item: ConfiguredContinuousProfile): SharedProfile =>
  ({ profile: item.profile, label: item.label, enabled: item.enabled, visible: item.visible });
