import { describe, it, expect } from 'vitest';
import type { Universe } from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';
import { installBuiltInMissionPlugins } from '../mission-plugins';

const renderer = () => { const used: string[] = []; return { used, renderer: { use: (p: { name: string }) => { used.push(p.name); } } as unknown as UniverseRenderer }; };
const universeWith = (bodies: unknown[]) => ({ getAllBodies: () => bodies }) as unknown as Universe;

describe('built-in mission plugins', () => {
  it('discovers the repository mission packages and installs none on a scene they do not apply to', () => {
    const { used, renderer: r } = renderer();
    expect(installBuiltInMissionPlugins(r, universeWith([]))).toEqual([]);
    expect(used).toEqual([]);
  });

  it('offers discovered registrations to the scene (a registration given explicitly is installed when it applies)', () => {
    const { used, renderer: r } = renderer();
    const installed = installBuiltInMissionPlugins(r, universeWith([]), [{ id: 'probe', appliesTo: () => true, create: () => ({ name: 'probe' }) }]);
    expect(installed).toEqual(['probe']);
    expect(used).toEqual(['probe']);
  });
});
