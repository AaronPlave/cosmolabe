import { describe, expect, it } from 'vitest';
import { KEYMAP, heldCameraBindingForCode, matchKeyBinding, shortcutFor } from '../keymap';

describe('keyboard map', () => {
  it('assigns each physical viewer key combination once', () => {
    const viewerBindings = KEYMAP.filter(binding => binding.scope !== 'camera');
    const combinations = viewerBindings.map(binding => `${binding.primary ? 'primary+' : ''}${binding.shift ? 'shift+' : ''}${binding.key.toLowerCase()}`);
    expect(new Set(combinations).size).toBe(combinations.length);
  });

  it('matches viewer keys and leaves renderer-owned camera keys to the renderer', () => {
    expect(matchKeyBinding({ key: 'T', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })?.id).toBe('disp:traj');
    expect(matchKeyBinding({ key: 'w', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeUndefined();
    expect(matchKeyBinding({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })?.id).toBe('search:open');
  });

  it('provides labels from the same registry used for help', () => {
    expect(shortcutFor('cam:dolly-in')).toBe('[');
    expect(shortcutFor('instr:open')).toBe('I');
  });

  it('releases held camera verbs by physical key code', () => {
    expect(heldCameraBindingForCode('BracketLeft')?.id).toBe('cam:dolly-in');
    expect(heldCameraBindingForCode('PageDown')?.id).toBe('cam:crane-down');
    expect(heldCameraBindingForCode('KeyW')).toBeUndefined();
  });
});