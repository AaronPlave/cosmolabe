import { describe, it, expect, vi } from 'vitest';
import type { Universe } from '@cosmolabe/core';
import { installMissionPlugins, type MissionPluginRegistration } from '../plugins/MissionPlugin.js';
import type { RendererPlugin } from '../plugins/RendererPlugin.js';

const universe = {} as Universe;
const recorder = () => { const used: RendererPlugin[] = []; return { used, renderer: { use: (p: RendererPlugin) => { used.push(p); } } }; };
const reg = (id: string, applies: boolean): MissionPluginRegistration => ({ id, appliesTo: () => applies, create: () => ({ name: id }) });

describe('installMissionPlugins', () => {
  it('installs only the registrations that apply to the scene', () => {
    const { used, renderer } = recorder();
    expect(installMissionPlugins(renderer, universe, [reg('a', true), reg('b', false), reg('c', true)])).toEqual(['a', 'c']);
    expect(used.map((p) => p.name)).toEqual(['a', 'c']);
  });

  it('creates a fresh plugin per scene and never creates one that does not apply', () => {
    const create = vi.fn(() => ({ name: 'x' }));
    const r: MissionPluginRegistration = { id: 'x', appliesTo: () => false, create };
    installMissionPlugins(recorder().renderer, universe, [r]);
    expect(create).not.toHaveBeenCalled();
    const applies: MissionPluginRegistration = { ...r, appliesTo: () => true };
    const a = recorder(), b = recorder();
    installMissionPlugins(a.renderer, universe, [applies]); installMissionPlugins(b.renderer, universe, [applies]);
    expect(a.used[0]).not.toBe(b.used[0]);
  });

  it('ignores a duplicate id', () => {
    const { renderer } = recorder();
    expect(installMissionPlugins(renderer, universe, [reg('a', true), reg('a', true)])).toEqual(['a']);
  });

  it('a throwing or malformed registration disables only itself', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { used, renderer } = recorder();
    const boom: MissionPluginRegistration = { id: 'boom', appliesTo: () => { throw new Error('bad'); }, create: () => ({ name: 'boom' }) };
    const createFails: MissionPluginRegistration = { id: 'cf', appliesTo: () => true, create: () => { throw new Error('nope'); } };
    expect(installMissionPlugins(renderer, universe, [boom, createFails, {} as MissionPluginRegistration, reg('ok', true)])).toEqual(['ok']);
    expect(used.map((p) => p.name)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
