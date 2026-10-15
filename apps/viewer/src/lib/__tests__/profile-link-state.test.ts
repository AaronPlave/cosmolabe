import { describe, expect, it } from 'vitest';
import { validateProfileLinkState, type ProfileLinkState } from '../profile-link-state';
import { requestedView, viewLink } from '../view-state-url';

const state = (): ProfileLinkState => ({ version: 1, profiles: [
  { profile: { quantity: 'range', bodies: { observer: 'Earth', target: 'Moon' } }, label: 'Distance', enabled: true, visible: false },
  { profile: { quantity: 'phase-angle', bodies: { observer: 'Earth', target: 'Moon', illuminator: 'Sun' }, abcorr: 'LT+S' }, label: 'Phase', enabled: false, visible: true },
] });

describe('profile link schema', () => {
  it('keeps definitions, flags and row order, and drops unknown keys', () => {
    const s = state() as unknown as { profiles: { profile: Record<string, unknown> }[] };
    s.profiles[0].profile.samples = [1, 2, 3];
    const out = validateProfileLinkState(s);
    expect(out).toEqual(state());
    expect(out.profiles.map(p => p.label)).toEqual(['Distance', 'Phase']);
  });

  it('rejects unknown quantities, bad bodies/flags/steps and more than 16 profiles', () => {
    const bad = (mutate: (s: any) => void) => { const s = state(); mutate(s); return () => validateProfileLinkState(s); };
    expect(bad(s => { s.profiles[0].profile.quantity = 'nope'; })).toThrow(/Profile context.*unavailable/);
    expect(bad(s => { s.profiles[0].profile.bodies.observer = ''; })).toThrow(/observer/);
    expect(bad(s => { s.profiles[0].enabled = 'yes'; })).toThrow(/flags/);
    expect(bad(s => { s.profiles[0].profile.step = 0; })).toThrow(/step/);
    expect(bad(s => { s.profiles[0].profile.abcorr = 'XX'; })).toThrow(/aberration/);
    expect(bad(s => { s.profiles = Array(17).fill(s.profiles[0]); })).toThrow(/at most 16/);
    expect(bad(s => { s.version = 2; })).toThrow(/version/);
  });

  it('round-trips through the share URL next to the base view', () => {
    const page = 'https://viewer.example/';
    const base = requestedView('?view=' + encodeURIComponent(JSON.stringify({ version: 1, catalog: { catalog: 'earth-moon' },
      time: { kind: 'fixed', source: 'ET', et: 1 }, view: { kind: 'named', name: 'Lunar Orbit', fov: 42 },
      navigation: { selected: null, tracked: null, lookAt: null, mode: 'free-orbit' }, playback: { playing: false, rate: 1 },
      display: { labels: false, trajectories: true, grid: true } })))!;
    const withProfiles = { ...base, profiles: state() };
    expect(requestedView(new URL(viewLink(withProfiles, page)).search)).toEqual(withProfiles);
    const tampered = { ...withProfiles, profiles: { ...state(), version: 9 } };
    expect(() => requestedView(`?view=${encodeURIComponent(JSON.stringify(tampered))}`)).toThrow(/Profile context.*version/);
  });
});
